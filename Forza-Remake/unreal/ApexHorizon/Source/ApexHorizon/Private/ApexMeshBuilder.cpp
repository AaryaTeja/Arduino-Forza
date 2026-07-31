// Apex Horizon — CPU-side mesh accumulation.

#include "ApexMeshBuilder.h"
#include "ApexHorizon.h"
#include "ApexMath.h"
#include "ApexTrackSpline.h"

using namespace ApexMath;

void FApexMeshData::Append(const FApexMeshData& Other)
{
	const int32 Base = Vertices.Num();
	Vertices.Append(Other.Vertices);
	Normals.Append(Other.Normals);
	UV0.Append(Other.UV0);
	Colors.Append(Other.Colors);
	Tangents.Append(Other.Tangents);
	Triangles.Reserve(Triangles.Num() + Other.Triangles.Num());
	for (int32 Index : Other.Triangles)
	{
		Triangles.Add(Base + Index);
	}
}

void FApexMeshData::ComputeNormals()
{
	Normals.Init(FVector::ZeroVector, Vertices.Num());

	for (int32 i = 0; i + 2 < Triangles.Num(); i += 3)
	{
		const int32 Ia = Triangles[i], Ib = Triangles[i + 1], Ic = Triangles[i + 2];
		const FVector& A = Vertices[Ia];
		const FVector& B = Vertices[Ib];
		const FVector& C = Vertices[Ic];
		// Unweighted cross keeps the area weighting implicit in its magnitude.
		const FVector FaceNormal = FVector::CrossProduct(C - A, B - A);
		Normals[Ia] += FaceNormal;
		Normals[Ib] += FaceNormal;
		Normals[Ic] += FaceNormal;
	}

	Tangents.SetNum(Vertices.Num());
	for (int32 i = 0; i < Normals.Num(); ++i)
	{
		Normals[i] = Normals[i].GetSafeNormal(1e-8, FVector::UpVector);
		// A stable tangent is enough for the procedural materials in use here.
		const FVector Ref = FMath::Abs(Normals[i].Z) > 0.95 ? FVector::ForwardVector : FVector::UpVector;
		const FVector Tangent = FVector::CrossProduct(Ref, Normals[i]).GetSafeNormal(1e-8, FVector::ForwardVector);
		Tangents[i] = FProcMeshTangent(Tangent, false);
	}
}

void FApexMeshData::ComputeFlatNormals()
{
	ComputeNormals();
}

void FApexMeshData::AddBox(const FVector& Center, const FVector& HalfExtents, const FQuat& Rotation,
	const FColor& C, double UvScale)
{
	static const FVector Corners[8] = {
		FVector(-1, -1, -1), FVector(+1, -1, -1), FVector(+1, +1, -1), FVector(-1, +1, -1),
		FVector(-1, -1, +1), FVector(+1, -1, +1), FVector(+1, +1, +1), FVector(-1, +1, +1),
	};
	// Faces wound so (C - A) ^ (B - A) points outward.
	static const int32 Faces[6][4] = {
		{ 4, 7, 6, 5 }, // +Z
		{ 0, 1, 2, 3 }, // -Z
		{ 1, 5, 6, 2 }, // +X
		{ 0, 3, 7, 4 }, // -X
		{ 3, 2, 6, 7 }, // +Y
		{ 0, 4, 5, 1 }, // -Y
	};

	const double Inv = UvScale > 0.0 ? 1.0 / UvScale : 0.01;
	for (const int32(&Face)[4] : Faces)
	{
		const int32 Start = Vertices.Num();
		for (int32 K = 0; K < 4; ++K)
		{
			const FVector Local = Corners[Face[K]] * HalfExtents;
			const FVector World = Center + Rotation.RotateVector(Local);
			// Cheap planar UVs: pick the two axes with the largest local extent.
			const FVector2D Uv(
				(FMath::Abs(Local.X) >= FMath::Abs(Local.Y) ? World.Y : World.X) * Inv,
				World.Z * Inv);
			AddVertex(World, Uv, C);
		}
		AddQuad(Start, Start + 1, Start + 2, Start + 3);
	}
}

void FApexMeshData::AddPrism(const TArray<FVector2D>& Poly, double BaseZ, double TopZ,
	const FColor& C, double UvScale, bool bCapTop)
{
	const int32 N = Poly.Num();
	if (N < 3)
	{
		return;
	}
	const double Inv = UvScale > 0.0 ? 1.0 / UvScale : 0.01;

	// walls
	double Run = 0.0;
	for (int32 i = 0; i < N; ++i)
	{
		const FVector2D& P0 = Poly[i];
		const FVector2D& P1 = Poly[(i + 1) % N];
		const double SegLen = FVector2D::Distance(P0, P1);

		const int32 Start = Vertices.Num();
		AddVertex(FVector(P0.X, P0.Y, BaseZ), FVector2D(Run * Inv, BaseZ * Inv), C);
		AddVertex(FVector(P1.X, P1.Y, BaseZ), FVector2D((Run + SegLen) * Inv, BaseZ * Inv), C);
		AddVertex(FVector(P1.X, P1.Y, TopZ), FVector2D((Run + SegLen) * Inv, TopZ * Inv), C);
		AddVertex(FVector(P0.X, P0.Y, TopZ), FVector2D(Run * Inv, TopZ * Inv), C);
		AddQuad(Start, Start + 1, Start + 2, Start + 3);
		Run += SegLen;
	}

	if (bCapTop)
	{
		const int32 Start = Vertices.Num();
		for (const FVector2D& P : Poly)
		{
			AddVertex(FVector(P.X, P.Y, TopZ), FVector2D(P.X * Inv, P.Y * Inv), C);
		}
		for (int32 i = 1; i + 1 < N; ++i)
		{
			AddTriangle(Start, Start + i, Start + i + 1);
		}
	}
}

void FApexMeshData::AddCylinder(const FVector& Base, double RadiusBottom, double RadiusTop, double Height,
	int32 Sides, const FQuat& Rotation, const FColor& C, bool bCaps)
{
	Sides = FMath::Max(3, Sides);
	const int32 Start = Vertices.Num();

	for (int32 i = 0; i <= Sides; ++i)
	{
		const double A = (2.0 * PI * i) / Sides;
		const double Cos = FMath::Cos(A), Sin = FMath::Sin(A);
		const FVector Lower = Rotation.RotateVector(FVector(Cos * RadiusBottom, Sin * RadiusBottom, 0.0));
		const FVector Upper = Rotation.RotateVector(FVector(Cos * RadiusTop, Sin * RadiusTop, Height));
		const double U = static_cast<double>(i) / Sides;
		AddVertex(Base + Lower, FVector2D(U, 0.0), C);
		AddVertex(Base + Upper, FVector2D(U, 1.0), C);
	}
	for (int32 i = 0; i < Sides; ++i)
	{
		const int32 A = Start + i * 2;
		AddQuad(A, A + 2, A + 3, A + 1);
	}

	if (bCaps)
	{
		if (RadiusTop > KINDA_SMALL_NUMBER)
		{
			const int32 CapStart = Vertices.Num();
			for (int32 i = 0; i < Sides; ++i)
			{
				const double A = (2.0 * PI * i) / Sides;
				const FVector P = Rotation.RotateVector(FVector(FMath::Cos(A) * RadiusTop, FMath::Sin(A) * RadiusTop, Height));
				AddVertex(Base + P, FVector2D(FMath::Cos(A) * 0.5 + 0.5, FMath::Sin(A) * 0.5 + 0.5), C);
			}
			for (int32 i = 1; i + 1 < Sides; ++i)
			{
				AddTriangle(CapStart, CapStart + i, CapStart + i + 1);
			}
		}
		if (RadiusBottom > KINDA_SMALL_NUMBER)
		{
			const int32 CapStart = Vertices.Num();
			for (int32 i = 0; i < Sides; ++i)
			{
				const double A = (2.0 * PI * i) / Sides;
				const FVector P = Rotation.RotateVector(FVector(FMath::Cos(A) * RadiusBottom, FMath::Sin(A) * RadiusBottom, 0.0));
				AddVertex(Base + P, FVector2D(FMath::Cos(A) * 0.5 + 0.5, FMath::Sin(A) * 0.5 + 0.5), C);
			}
			for (int32 i = 1; i + 1 < Sides; ++i)
			{
				AddTriangle(CapStart, CapStart + i + 1, CapStart + i);
			}
		}
	}
}

void FApexMeshData::AddEllipsoid(const FVector& Center, const FVector& Radii, int32 Segments, int32 Rings,
	const FColor& C)
{
	Segments = FMath::Max(3, Segments);
	Rings = FMath::Max(2, Rings);
	const int32 Start = Vertices.Num();

	for (int32 R = 0; R <= Rings; ++R)
	{
		const double V = static_cast<double>(R) / Rings;
		const double Phi = V * PI;
		const double SinPhi = FMath::Sin(Phi), CosPhi = FMath::Cos(Phi);
		for (int32 Sg = 0; Sg <= Segments; ++Sg)
		{
			const double U = static_cast<double>(Sg) / Segments;
			const double Theta = U * 2.0 * PI;
			const FVector P(
				SinPhi * FMath::Cos(Theta) * Radii.X,
				SinPhi * FMath::Sin(Theta) * Radii.Y,
				CosPhi * Radii.Z);
			AddVertex(Center + P, FVector2D(U, V), C);
		}
	}

	const int32 Stride = Segments + 1;
	for (int32 R = 0; R < Rings; ++R)
	{
		for (int32 Sg = 0; Sg < Segments; ++Sg)
		{
			const int32 A = Start + R * Stride + Sg;
			const int32 B = A + Stride;
			AddQuad(A, A + 1, B + 1, B);
		}
	}
}

int32 FApexMeshData::SanitiseNonFinite(const TCHAR* Context)
{
	TArray<bool> bBad;
	bBad.SetNumZeroed(Vertices.Num());

	int32 BadVerts = 0;
	int32 FirstBad = INDEX_NONE;
	for (int32 i = 0; i < Vertices.Num(); ++i)
	{
		if (Vertices[i].ContainsNaN())
		{
			bBad[i] = true;
			++BadVerts;
			if (FirstBad == INDEX_NONE)
			{
				FirstBad = i;
			}
		}
	}
	if (BadVerts == 0)
	{
		return 0;
	}

	TArray<int32> Kept;
	Kept.Reserve(Triangles.Num());
	int32 DroppedTris = 0;
	for (int32 i = 0; i + 2 < Triangles.Num(); i += 3)
	{
		if (bBad[Triangles[i]] || bBad[Triangles[i + 1]] || bBad[Triangles[i + 2]])
		{
			++DroppedTris;
			continue;
		}
		Kept.Add(Triangles[i]);
		Kept.Add(Triangles[i + 1]);
		Kept.Add(Triangles[i + 2]);
	}
	Triangles = MoveTemp(Kept);

	// Leave the vertices in place so the indices stay valid; the orphans cost nothing.
	for (int32 i = 0; i < Vertices.Num(); ++i)
	{
		if (bBad[i])
		{
			Vertices[i] = FVector::ZeroVector;
		}
	}

	UE_LOG(LogApex, Warning,
		TEXT("%s: %d non-finite vertices (first at %d), dropped %d triangles"),
		Context, BadVerts, FirstBad, DroppedTris);
	return BadVerts;
}

void FApexMeshData::ToSection(UProceduralMeshComponent* Component, int32 SectionIndex, bool bCreateCollision) const
{
	if (!Component || Triangles.Num() == 0)
	{
		return;
	}
	Component->CreateMeshSection(SectionIndex, Vertices, Triangles, Normals, UV0, Colors, Tangents, bCreateCollision);
}

namespace ApexMesh
{
	void BuildRibbon(
		const FApexTrackSpline& Spline,
		const TArray<int32>& Indices,
		TFunctionRef<void(int32, int32, TArray<FApexProfilePoint>&)> ProfileFn,
		FApexMeshData& Out,
		double VScale,
		bool bClosed,
		const FColor& Colour)
	{
		const int32 Rows = Indices.Num();
		if (Rows < 2)
		{
			return;
		}

		TArray<FApexProfilePoint> Profile;
		ProfileFn(Indices[0], 0, Profile);
		const int32 Cols = Profile.Num();
		if (Cols < 2)
		{
			return;
		}

		const int32 Base = Out.Vertices.Num();
		Out.Reserve(Base + Rows * Cols, Rows * Cols * 2);

		FVector Right, Up, Fwd;
		for (int32 R = 0; R < Rows; ++R)
		{
			const int32 i = Indices[R];
			Spline.FrameAt(i, Right, Up, Fwd);
			if (R > 0)
			{
				ProfileFn(i, R, Profile);
			}

			// Centreline point in Unreal space; the profile offsets are metres.
			const FVector Centre = ApexToUE(Spline.X[i], Spline.Y[i], Spline.Z[i]);
			const double V = Spline.S[i] * VScale;

			for (int32 Cix = 0; Cix < Cols; ++Cix)
			{
				const FApexProfilePoint& P = Profile[Cix];
				const FVector World = Centre
					+ Right * (P.X * APEX_TO_UE)
					+ Up * (P.Y * APEX_TO_UE);
				Out.AddVertex(World, FVector2D(P.U, V), Colour);
			}
		}

		const int32 RowCount = bClosed ? Rows : Rows - 1;
		for (int32 R = 0; R < RowCount; ++R)
		{
			const int32 R0 = Base + R * Cols;
			const int32 R1 = Base + ((R + 1) % Rows) * Cols;
			for (int32 Cix = 0; Cix + 1 < Cols; ++Cix)
			{
				Out.AddTriangle(R0 + Cix, R1 + Cix, R0 + Cix + 1);
				Out.AddTriangle(R0 + Cix + 1, R1 + Cix, R1 + Cix + 1);
			}
		}
	}

	TArray<TArray<int32>> FindRuns(const FApexTrackSpline& Spline, TFunctionRef<bool(int32)> Predicate,
		int32 MinLen, int32 Pad)
	{
		const int32 N = Spline.Count;
		TArray<uint8> Hit;
		Hit.SetNumZeroed(N);
		for (int32 i = 0; i < N; ++i)
		{
			Hit[i] = Predicate(i) ? 1 : 0;
		}

		if (Pad > 0)
		{
			TArray<uint8> Grown = Hit;
			for (int32 i = 0; i < N; ++i)
			{
				if (!Hit[i])
				{
					continue;
				}
				for (int32 K = -Pad; K <= Pad; ++K)
				{
					Grown[((i + K) % N + N) % N] = 1;
				}
			}
			Hit = MoveTemp(Grown);
		}

		TArray<TArray<int32>> Runs;

		// rotate so we never start mid-run
		int32 Offset = 0;
		while (Offset < N && Hit[Offset])
		{
			++Offset;
		}
		if (Offset >= N)
		{
			TArray<int32> All;
			All.Reserve(N);
			for (int32 i = 0; i < N; ++i)
			{
				All.Add(i);
			}
			Runs.Add(MoveTemp(All));
			return Runs;
		}

		int32 Start = -1;
		for (int32 K = 0; K <= N; ++K)
		{
			const int32 i = (Offset + K) % N;
			const bool bOn = K < N && Hit[i] != 0;
			if (bOn && Start < 0)
			{
				Start = K;
			}
			else if (!bOn && Start >= 0)
			{
				if (K - Start >= MinLen)
				{
					TArray<int32> Arr;
					Arr.Reserve(K - Start + 1);
					for (int32 Q = Start; Q <= K; ++Q)
					{
						Arr.Add((Offset + FMath::Min(Q, N - 1)) % N);
					}
					Runs.Add(MoveTemp(Arr));
				}
				Start = -1;
			}
		}
		return Runs;
	}

	double RunTaper(int32 RunLength, int32 Row)
	{
		if (RunLength < 5)
		{
			return 1.0;
		}
		const double FadeLen = FMath::Min(6, RunLength / 3);
		return FMath::Min(SmoothStep(0.0, FadeLen, Row), SmoothStep(0.0, FadeLen, RunLength - 1 - Row));
	}

	void SplitIntoChunks(const FApexMeshGroup& Source, double ChunkSizeCm, TArray<FApexMeshGroup>& Out)
	{
		if (Source.IsEmpty() || ChunkSizeCm <= 0.0)
		{
			return;
		}

		// chunk key -> index into a local list, so only occupied chunks become groups
		TMap<uint64, int32> ChunkLookup;
		TArray<FApexMeshGroup> Chunks;
		// (chunk, section, source vertex) -> vertex index within that chunk's section
		TMap<uint64, TMap<int32, int32>> VertexRemap;

		auto ChunkKey = [ChunkSizeCm](const FVector& P) -> uint64
		{
			const int32 Cx = FMath::FloorToInt32(P.X / ChunkSizeCm) + 32768;
			const int32 Cy = FMath::FloorToInt32(P.Y / ChunkSizeCm) + 32768;
			return (static_cast<uint64>(Cx) << 32) | static_cast<uint32>(Cy);
		};

		for (int32 SectionIdx = 0; SectionIdx < Source.NumSections(); ++SectionIdx)
		{
			const FApexMeshData& Src = Source.SectionAt(SectionIdx);
			const FName Material = Source.SectionMaterials[SectionIdx];

			for (int32 T = 0; T + 2 < Src.Triangles.Num(); T += 3)
			{
				const int32 Ia = Src.Triangles[T];
				const int32 Ib = Src.Triangles[T + 1];
				const int32 Ic = Src.Triangles[T + 2];
				const FVector Centroid = (Src.Vertices[Ia] + Src.Vertices[Ib] + Src.Vertices[Ic]) / 3.0;
				const uint64 Key = ChunkKey(Centroid);

				int32* Found = ChunkLookup.Find(Key);
				if (!Found)
				{
					const int32 NewIndex = Chunks.Num();
					FApexMeshGroup& Chunk = Chunks.AddDefaulted_GetRef();
					Chunk.Name = FString::Printf(TEXT("%s_%d"), *Source.Name, NewIndex);
					Chunk.bCollision = Source.bCollision;
					Chunk.bCastShadow = Source.bCastShadow;
					Found = &ChunkLookup.Add(Key, NewIndex);
				}

				FApexMeshGroup& Chunk = Chunks[*Found];
				FApexMeshData& Dst = Chunk.SectionFor(Material);
				TMap<int32, int32>& Remap = VertexRemap.FindOrAdd(
					(static_cast<uint64>(*Found) << 20) | static_cast<uint32>(SectionIdx));

				const int32 SourceIndices[3] = { Ia, Ib, Ic };
				int32 Mapped[3];
				for (int32 K = 0; K < 3; ++K)
				{
					const int32 SrcIdx = SourceIndices[K];
					if (const int32* Existing = Remap.Find(SrcIdx))
					{
						Mapped[K] = *Existing;
					}
					else
					{
						const int32 NewIdx = Dst.Vertices.Num();
						Dst.Vertices.Add(Src.Vertices[SrcIdx]);
						Dst.UV0.Add(Src.UV0.IsValidIndex(SrcIdx) ? Src.UV0[SrcIdx] : FVector2D::ZeroVector);
						Dst.Colors.Add(Src.Colors.IsValidIndex(SrcIdx) ? Src.Colors[SrcIdx] : FColor::White);
						Dst.Normals.Add(Src.Normals.IsValidIndex(SrcIdx) ? Src.Normals[SrcIdx] : FVector::UpVector);
						Dst.Tangents.Add(Src.Tangents.IsValidIndex(SrcIdx) ? Src.Tangents[SrcIdx] : FProcMeshTangent());
						Remap.Add(SrcIdx, NewIdx);
						Mapped[K] = NewIdx;
					}
				}
				Dst.AddTriangle(Mapped[0], Mapped[1], Mapped[2]);
			}
		}

		for (FApexMeshGroup& Chunk : Chunks)
		{
			Chunk.Compact();
			if (!Chunk.IsEmpty())
			{
				Out.Add(MoveTemp(Chunk));
			}
		}
	}
}
