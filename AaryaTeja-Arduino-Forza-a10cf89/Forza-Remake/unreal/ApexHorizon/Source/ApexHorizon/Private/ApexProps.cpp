// Apex Horizon — prop construction.

#include "ApexProps.h"
#include "ApexMath.h"
#include "ApexTerrain.h"
#include "ApexTrackSpline.h"

using namespace ApexMath;
using namespace ApexWorld;

namespace
{
	/** Rotation about Unreal's up axis, from an Apex-space yaw. */
	FQuat YawQuat(double Radians)
	{
		return FQuat(FVector::UpVector, Radians);
	}

	/**
	 * Box building whose UVs are expressed in tiles (one tile = one window bay × one
	 * storey), so windows keep a constant real-world size whatever the building's size.
	 */
	void AddBuilding(FApexMeshData& Out, const FVector& Base, double W, double H, double D,
		double Yaw, double BayW, double StoreyH, const FColor& C)
	{
		const double Hw = W * 0.5 * APEX_TO_UE;
		const double Hd = D * 0.5 * APEX_TO_UE;
		const double Ht = H * APEX_TO_UE;
		const double Nx = FMath::Max(1.0, FMath::RoundToDouble(W / BayW));
		const double Nz = FMath::Max(1.0, FMath::RoundToDouble(D / BayW));
		const double Ny = FMath::Max(1.0, FMath::RoundToDouble(H / StoreyH));

		const FQuat Rot = YawQuat(Yaw);
		auto P = [&](double X, double Y, double Z) { return Base + Rot.RotateVector(FVector(X, Y, Z)); };

		auto Wall = [&](const FVector& A, const FVector& B, const FVector& Cc, const FVector& E, double Uw, double Uh)
		{
			const int32 Start = Out.Vertices.Num();
			Out.AddVertex(A, FVector2D(0, 0), C);
			Out.AddVertex(B, FVector2D(Uw, 0), C);
			Out.AddVertex(Cc, FVector2D(Uw, Uh), C);
			Out.AddVertex(E, FVector2D(0, Uh), C);
			Out.AddQuad(Start, Start + 1, Start + 2, Start + 3);
		};

		// +Y, -Y, +X, -X faces (Unreal axes; the building's own local frame)
		Wall(P(-Hw, Hd, 0), P(Hw, Hd, 0), P(Hw, Hd, Ht), P(-Hw, Hd, Ht), Nx, Ny);
		Wall(P(Hw, -Hd, 0), P(-Hw, -Hd, 0), P(-Hw, -Hd, Ht), P(Hw, -Hd, Ht), Nx, Ny);
		Wall(P(Hw, Hd, 0), P(Hw, -Hd, 0), P(Hw, -Hd, Ht), P(Hw, Hd, Ht), Nz, Ny);
		Wall(P(-Hw, -Hd, 0), P(-Hw, Hd, 0), P(-Hw, Hd, Ht), P(-Hw, -Hd, Ht), Nz, Ny);
	}

	/** Roof slab, parapet, plant boxes and the occasional mast. */
	void AddRoof(FApexMeshData& Out, const FVector& Base, double W, double H, double D,
		double Yaw, FRng& Rng, const FColor& C)
	{
		const FQuat Rot = YawQuat(Yaw);
		const double Wc = W * APEX_TO_UE, Dc = D * APEX_TO_UE, Hc = H * APEX_TO_UE;
		auto At = [&](double X, double Y, double Z) { return Base + Rot.RotateVector(FVector(X, Y, Z)); };

		// slab
		Out.AddBox(At(0, 0, Hc + 0.15 * APEX_TO_UE),
			FVector(Wc * 0.5 + 15, Dc * 0.5 + 15, 25), Rot, C);

		// parapet
		const double Par = 0.85 * APEX_TO_UE;
		Out.AddBox(At(0, Dc * 0.5, Hc + 0.75 * APEX_TO_UE), FVector(Wc * 0.5 + 30, 17, Par * 0.5), Rot, C);
		Out.AddBox(At(0, -Dc * 0.5, Hc + 0.75 * APEX_TO_UE), FVector(Wc * 0.5 + 30, 17, Par * 0.5), Rot, C);
		Out.AddBox(At(Wc * 0.5, 0, Hc + 0.75 * APEX_TO_UE), FVector(17, Dc * 0.5 + 30, Par * 0.5), Rot, C);
		Out.AddBox(At(-Wc * 0.5, 0, Hc + 0.75 * APEX_TO_UE), FVector(17, Dc * 0.5 + 30, Par * 0.5), Rot, C);

		// rooftop plant
		const int32 Units = 1 + Rng.RangeInt(0, 3);
		for (int32 i = 0; i < Units; ++i)
		{
			const double Uw = (1.4 + Rng() * 3.2) * APEX_TO_UE;
			const double Uh = (1.0 + Rng() * 2.4) * APEX_TO_UE;
			const double Ud = (1.4 + Rng() * 3.2) * APEX_TO_UE;
			Out.AddBox(
				At((Rng() - 0.5) * (Wc - Uw - 100), (Rng() - 0.5) * (Dc - Ud - 100), Hc + 40 + Uh * 0.5),
				FVector(Uw * 0.5, Ud * 0.5, Uh * 0.5), Rot, C);
		}

		if (Rng() > 0.6)
		{
			const double MastH = (4.0 + Rng() * 8.0) * APEX_TO_UE;
			Out.AddCylinder(At((Rng() - 0.5) * Wc * 0.5, (Rng() - 0.5) * Dc * 0.5, Hc + 40),
				18, 12, MastH, 6, Rot, C);
		}
	}
}

void ApexProps::BuildCity(const FApexTrackSpline& Spline, const FApexTerrain& Terrain,
	double Density, FApexPropsResult& Out)
{
	FRng Rng(0xc17a);

	FApexMeshGroup& Group = Out.AddGroup(TEXT("City"));
	const FName FacadeKeys[3] = { "facadeA", "facadeB", "facadeC" };

	constexpr double Grid = 34.0;
	const int32 Span = FMath::CeilToInt32((CityRadius + 120.0) / Grid);

	for (int32 Gx = -Span; Gx <= Span; ++Gx)
	{
		for (int32 Gz = -Span; Gz <= Span; ++Gz)
		{
			const double JitterX = (Rng() - 0.5) * 11.0;
			const double JitterZ = (Rng() - 0.5) * 11.0;
			const double Cx = CityX + Gx * Grid + JitterX;
			const double Cz = CityZ + Gz * Grid + JitterZ;

			const double DistCity = FMath::Sqrt(FMath::Square(Cx - CityX) + FMath::Square(Cz - CityZ));
			if (DistCity > CityRadius + 80.0)
			{
				continue;
			}
			const double DensityHere = 1.0 - SmoothStep(CityRadius * 0.55, CityRadius + 70.0, DistCity);
			if (Rng() > DensityHere * 0.94 * Density)
			{
				continue;
			}

			const FApexSplineQuery Q = Spline.Query(Cx, Cz);
			const double Clearance = (Q.bFar ? 999.0 : Q.Dist) - (Q.bFar ? 0.0 : Q.HalfWidth + APEX_SHOULDER);
			if (Clearance < 7.5)
			{
				continue;
			}

			const double W = 12.0 + Rng() * 15.0;
			const double D = 12.0 + Rng() * 15.0;
			if (!Q.bFar && Q.Dist < Q.HalfWidth + APEX_SHOULDER + FMath::Max(W, D) * 0.5 + 4.5)
			{
				continue;
			}

			const double CoreT = 1.0 - SmoothStep(0.0, CityRadius * 0.8, DistCity);
			const double H = Lerp(9.0, 16.0, Rng()) + FMath::Pow(Rng(), 1.7) * Lerp(16.0, 74.0, CoreT);

			const double Gy = Terrain.Sample(Cx, Cz) - 0.6;
			const double Yaw = FMath::RoundToDouble(Rng() * 4.0) * (PI * 0.5) + (Rng() - 0.5) * 0.09;

			const int32 Variant = Rng.RangeInt(0, 3);
			const FVector Base = ApexToUE(Cx, Gy, Cz);
			const FColor Tint = FLinearColor(
				0.62f + static_cast<float>(Rng()) * 0.3f,
				0.64f + static_cast<float>(Rng()) * 0.28f,
				0.68f + static_cast<float>(Rng()) * 0.3f).ToFColor(false);

			AddBuilding(Group.SectionFor(FacadeKeys[Variant]), Base, W, H, D,
				Yaw, 3.0 + Rng() * 1.0, 3.3 + Rng() * 0.6, Tint);
			AddRoof(Group.SectionFor("concrete"), Base, W, H, D, Yaw, Rng, FColor(150, 150, 152));

			FApexBoxCollider Box;
			Box.Center = ApexToUE(Cx, Gy + H * 0.5, Cz);
			Box.HalfExtents = FVector(W * 0.5, D * 0.5, H * 0.5 + 1.2) * APEX_TO_UE;
			Box.Rotation = YawQuat(Yaw);
			Box.Friction = 0.6f;
			Box.Restitution = 0.05f;
			Out.BoxColliders.Add(Box);
			++Out.BuildingCount;
		}
	}

	Group.ComputeNormals();
	Group.Compact();
}

void ApexProps::BuildVegetation(const FApexTrackSpline& Spline, const FApexTerrain& Terrain,
	double Density, FApexPropsResult& Out)
{
	FRng Rng(0x77ee);
	const double HalfArea = Half - 60.0;

	// Chunked so the renderer can cull; each chunk is one component with several sections.
	constexpr int32 Chunks = 6;
	const int32 FirstGroup = Out.Groups.Num();
	for (int32 i = 0; i < Chunks * Chunks; ++i)
	{
		Out.AddGroup(FString::Printf(TEXT("Vegetation_%d"), i));
	}
	auto ChunkFor = [&](double X, double Z) -> FApexMeshGroup&
	{
		const int32 Cx = FMath::Clamp(FMath::FloorToInt32((X + Half) / (Size / Chunks)), 0, Chunks - 1);
		const int32 Cz = FMath::Clamp(FMath::FloorToInt32((Z + Half) / (Size / Chunks)), 0, Chunks - 1);
		return Out.Groups[FirstGroup + Cz * Chunks + Cx];
	};

	const int32 Target = FMath::RoundToInt32(6200.0 * Density);
	const int32 Attempts = Target * 4;
	int32 Placed = 0;

	for (int32 A = 0; A < Attempts && Placed < Target; ++A)
	{
		const double X = (Rng() * 2.0 - 1.0) * HalfArea;
		const double Z = (Rng() * 2.0 - 1.0) * HalfArea;

		const double CityD = FMath::Sqrt(FMath::Square(X - CityX) + FMath::Square(Z - CityZ));
		if (CityD < CityRadius * 0.9)
		{
			continue;
		}

		const FApexSplineQuery Q = Spline.Query(X, Z);
		const double RoadClear = Q.bFar ? 999.0 : Q.Dist - Q.HalfWidth - APEX_SHOULDER;
		if (RoadClear < 5.5)
		{
			continue;
		}

		const double Y = Terrain.Sample(X, Z);
		if (Y < WaterLevel + 1.6 || Y > 128.0)
		{
			continue;
		}

		const double Hx = Terrain.Sample(X + 4, Z) - Terrain.Sample(X - 4, Z);
		const double Hz = Terrain.Sample(X, Z + 4) - Terrain.Sample(X, Z - 4);
		const double Slope = FMath::Sqrt(Hx * Hx + Hz * Hz) / 8.0;
		if (Slope > 0.68 && Rng() > 0.12)
		{
			continue;
		}

		// forest clumping
		const double Clump = Fbm2(X * 0.0026, Z * 0.0026, 3);
		if (Rng() > Clamp01(0.28 + Clump * 1.5))
		{
			continue;
		}

		const bool bConifer = Y > 62.0 || Fbm2(X * 0.0012 + 90.0, Z * 0.0012, 2) > 0.12;
		const double S = 0.72 + Rng() * 0.75;
		const double Yaw = Rng() * 2.0 * PI;
		const FQuat Rot = YawQuat(Yaw);

		const double TrunkH = (bConifer ? 5.2 : 3.4) * S;
		const FVector BaseUE = ApexToUE(X, Y, Z);

		FApexMeshGroup& Chunk = ChunkFor(X, Z);
		const FColor BarkTint = FLinearColor(0.30f + static_cast<float>(Rng()) * 0.12f, 0.22f, 0.15f).ToFColor(false);
		Chunk.SectionFor("bark").AddCylinder(BaseUE,
			(bConifer ? 0.30 : 0.26) * S * APEX_TO_UE,
			(bConifer ? 0.12 : 0.16) * S * APEX_TO_UE,
			TrunkH * APEX_TO_UE, 5, Rot, BarkTint, /*bCaps*/ false);

		const double CanopyY = Y + TrunkH * (bConifer ? 0.62 : 0.92);
		const double Cs = (bConifer ? 2.1 : 3.1) * S;
		const FVector CanopyPos = ApexToUE(X, CanopyY, Z);
		const FColor LeafTint = FLinearColor(
			(bConifer ? 0.10f : 0.16f) + static_cast<float>(Rng()) * 0.06f,
			(bConifer ? 0.26f : 0.38f) + static_cast<float>(Rng()) * 0.10f,
			(bConifer ? 0.14f : 0.10f)).ToFColor(false);

		if (bConifer)
		{
			// cone: radius tapers to a point
			Chunk.SectionFor("leafConifer").AddCylinder(CanopyPos,
				Cs * APEX_TO_UE, 0.0, Cs * 1.9 * APEX_TO_UE, 8, Rot, LeafTint, /*bCaps*/ true);
		}
		else
		{
			const double Rx = Cs * (0.85 + Rng() * 0.3);
			const double Rz = Cs * (0.85 + Rng() * 0.3);
			Chunk.SectionFor("leafBroad").AddEllipsoid(
				CanopyPos + FVector(0, 0, Cs * 0.46 * APEX_TO_UE),
				FVector(Rx, Rz, Cs * 0.92) * APEX_TO_UE, 6, 4, LeafTint);
		}

		if (RoadClear < 48.0)
		{
			FApexCapsuleCollider Cap;
			Cap.Center = ApexToUE(X, Y + TrunkH * 0.7, Z);
			Cap.Radius = static_cast<float>(0.24 * S * APEX_TO_UE);
			Cap.HalfHeight = static_cast<float>(TrunkH * 0.7 * APEX_TO_UE);
			Out.CapsuleColliders.Add(Cap);
		}

		++Placed;
	}
	Out.TreeCount = Placed;

	// bushes and rocks scattered near the road for close-range detail
	const int32 DetailTarget = FMath::RoundToInt32(1500.0 * Density);
	int32 DetailPlaced = 0;
	for (int32 A = 0; A < DetailTarget * 5 && DetailPlaced < DetailTarget; ++A)
	{
		const double X = (Rng() * 2.0 - 1.0) * HalfArea;
		const double Z = (Rng() * 2.0 - 1.0) * HalfArea;

		const FApexSplineQuery Q = Spline.Query(X, Z);
		const double RoadClear = Q.bFar ? 999.0 : Q.Dist - Q.HalfWidth - APEX_SHOULDER;
		if (RoadClear < 2.2 || RoadClear > 110.0)
		{
			continue;
		}
		const double Y = Terrain.Sample(X, Z);
		if (Y < WaterLevel + 1.0)
		{
			continue;
		}

		const double S = 0.5 + Rng() * 0.9;
		FApexMeshGroup& Chunk = ChunkFor(X, Z);

		if (Rng() > 0.34)
		{
			Chunk.SectionFor("bush").AddEllipsoid(
				ApexToUE(X, Y + 0.25 * S, Z),
				FVector(S, S, S * 0.7) * APEX_TO_UE, 5, 3,
				FLinearColor(0.13f, 0.30f, 0.11f).ToFColor(false));
		}
		else
		{
			Chunk.SectionFor("rock").AddEllipsoid(
				ApexToUE(X, Y + 0.1 * S, Z),
				FVector(S * 1.3, S * 1.3, S * (0.6 + Rng() * 0.7)) * APEX_TO_UE, 5, 3,
				FLinearColor(0.30f, 0.29f, 0.27f).ToFColor(false));
		}
		++DetailPlaced;
	}

	for (int32 i = 0; i < Chunks * Chunks; ++i)
	{
		FApexMeshGroup& G = Out.Groups[FirstGroup + i];
		G.ComputeNormals();
		G.Compact();
	}
}

void ApexProps::BuildStreetFurniture(const FApexTrackSpline& Spline, const FApexTerrain& Terrain,
	double Density, FApexPropsResult& Out)
{
	FRng Rng(0x5a1e);
	FApexMeshGroup& Group = Out.AddGroup(TEXT("StreetFurniture"));
	FApexMeshData& Poles = Group.SectionFor("metalPole");
	FApexMeshData& Heads = Group.SectionFor("lampHead");
	FApexMeshData& Markers = Group.SectionFor("marker");

	const double PerSample = Spline.Length / Spline.Count;
	const int32 Step = FMath::Max(2, FMath::RoundToInt32(30.0 / PerSample));
	FVector Right, Up, Fwd;

	for (int32 i = 0; i < Spline.Count; i += Step)
	{
		if (Spline.Flags[i] & FApexTrackSpline::FLAG_TUNNEL)
		{
			continue;
		}
		const bool bInCity = (Spline.Flags[i] & FApexTrackSpline::FLAG_CITY) != 0;
		if (!bInCity && Rng() > 0.42 * Density)
		{
			continue;
		}

		const double Side = ((i / Step) % 2) ? 1.0 : -1.0;
		Spline.FrameAt(i, Right, Up, Fwd);
		const double Off = (Spline.Width[i] + APEX_SHOULDER + (bInCity ? 2.4 : 1.6)) * Side;
		const double Px = Spline.X[i] + Spline.Nx[i] * Off;
		const double Pz = Spline.Z[i] + Spline.Nz[i] * Off;
		const double Py = FMath::Min(Spline.Y[i], Terrain.Sample(Px, Pz) + 0.4) - 0.2;

		const FVector PoleBase = ApexToUE(Px, Py, Pz);
		// the arm reaches back over the road, so lamps light the racing surface
		const FVector Inward = -Right * Side;

		Poles.AddCylinder(PoleBase, 14, 10, 8.0 * APEX_TO_UE, 6, FQuat::Identity, FColor(90, 92, 96));

		constexpr double Arm = 2.45;
		const FVector HeadPos = PoleBase + Inward * (Arm * APEX_TO_UE) + FVector(0, 0, 7.94 * APEX_TO_UE);
		// arm from pole top to lamp head
		const FVector ArmMid = PoleBase + Inward * (Arm * 0.5 * APEX_TO_UE) + FVector(0, 0, 8.02 * APEX_TO_UE);
		Poles.AddBox(ArmMid,
			FVector(Arm * 0.5 * APEX_TO_UE, 6, 9),
			FRotationMatrix::MakeFromXZ(Inward, FVector::UpVector).ToQuat(), FColor(90, 92, 96));

		Heads.AddBox(HeadPos, FVector(48, 22, 8),
			FRotationMatrix::MakeFromXZ(Inward, FVector::UpVector).ToQuat(), FColor(220, 226, 236));

		Out.StreetLamps.Add(HeadPos - FVector(0, 0, 4));
	}

	// corner marker boards on quick corners
	const TArray<TArray<int32>> Runs = ApexMesh::FindRuns(Spline,
		[&Spline](int32 i)
		{
			return FMath::Abs(Spline.Curvature[i]) > 0.005
				&& !(Spline.Flags[i] & FApexTrackSpline::FLAG_TUNNEL);
		}, 5, 0);

	for (const TArray<int32>& Run : Runs)
	{
		const double Side = FMath::Sign(Spline.Curvature[Run[Run.Num() / 2]]) >= 0.0 ? -1.0 : 1.0;
		const int32 MarkStep = FMath::Max(2, FMath::RoundToInt32(9.0 / PerSample));
		for (int32 K = 0; K < Run.Num(); K += MarkStep)
		{
			const int32 i = Run[K];
			Spline.FrameAt(i, Right, Up, Fwd);
			const double Off = (Spline.Width[i] + APEX_SHOULDER + 1.1) * Side;
			const FVector Pos = ApexToUE(Spline.X[i], Spline.Y[i] - 0.1, Spline.Z[i]) + Right * (Off * APEX_TO_UE);
			const FQuat Rot = FRotationMatrix::MakeFromXZ(FVector(Fwd.X, Fwd.Y, 0).GetSafeNormal(), FVector::UpVector).ToQuat();

			Markers.AddCylinder(Pos, 4.5, 4.5, 60, 5, FQuat::Identity, FColor(140, 140, 145));
			Markers.AddBox(Pos + FVector(0, 0, 0.62 * APEX_TO_UE), FVector(3, 18, 45), Rot, FColor(240, 60, 40));
		}
	}

	// roadside fencing out in the countryside
	{
		FApexMeshData& Fence = Group.SectionFor("fence");
		FRng FenceRng(0x3f11);
		const int32 FenceStep = FMath::Max(2, FMath::RoundToInt32(4.0 / PerSample));
		for (int32 i = 0; i < Spline.Count; i += FenceStep)
		{
			const uint8 F = Spline.Flags[i];
			if (F & (FApexTrackSpline::FLAG_BRIDGE | FApexTrackSpline::FLAG_TUNNEL | FApexTrackSpline::FLAG_CITY))
			{
				continue;
			}
			if (FenceRng() > 0.55 * Density)
			{
				continue;
			}
			for (double Side : { 1.0, -1.0 })
			{
				Spline.FrameAt(i, Right, Up, Fwd);
				const double Off = (Spline.Width[i] + APEX_SHOULDER + 9.0 + FenceRng() * 4.0) * Side;
				const double Px = Spline.X[i] + Spline.Nx[i] * Off;
				const double Pz = Spline.Z[i] + Spline.Nz[i] * Off;
				const double Py = Terrain.Sample(Px, Pz);
				if (Py < WaterLevel + 1.0)
				{
					continue;
				}
				const FVector Pos = ApexToUE(Px, Py - 0.15, Pz);
				const FQuat Rot = FRotationMatrix::MakeFromXZ(FVector(Fwd.X, Fwd.Y, 0).GetSafeNormal(), FVector::UpVector).ToQuat();

				Fence.AddCylinder(Pos, 7.5, 6.0, 125, 5, FQuat::Identity, FColor(96, 78, 58));
				const double RailLen = PerSample * FenceStep * 1.12 * APEX_TO_UE;
				Fence.AddBox(Pos + FVector(0, 0, 0.77 * APEX_TO_UE),
					FVector(RailLen * 0.5, 2.5, 4.5), Rot, FColor(96, 78, 58));
			}
		}
	}

	Group.ComputeNormals();
	Group.Compact();
}

namespace
{
	/** Tunnel bore cross-section, right-bottom → over the top → left-bottom. */
	FVector2D ArchProfile(double Hw, int32 K, int32 KMax)
	{
		const double R = Hw + 2.2;
		constexpr double SpringY = 1.7;
		const double H = R * 0.92;
		if (K == 0) { return FVector2D(R, -0.4); }
		if (K == KMax) { return FVector2D(-R, -0.4); }
		if (K == 1) { return FVector2D(R, SpringY); }
		if (K == KMax - 1) { return FVector2D(-R, SpringY); }
		const double T = static_cast<double>(K - 1) / (KMax - 2);
		const double A = T * PI;
		return FVector2D(R * FMath::Cos(A), SpringY + H * FMath::Sin(A));
	}

	/** Hillside the tunnel is bored through. */
	FVector2D HillProfile(double Hw, int32 K, int32 KMax, double Taper, double X2, double Z2)
	{
		const double W = (Hw + 2.2) + 46.0 * Taper;
		const double H = 12.0 + 30.0 * Taper;
		if (K == 0) { return FVector2D(W, -3.0); }
		if (K == KMax) { return FVector2D(-W, -3.0); }
		const double T = static_cast<double>(K - 1) / (KMax - 2);
		const double A = T * PI;
		const double N = 1.0 + 0.16 * Fbm2(X2 * 0.02 + K * 0.7, Z2 * 0.02, 2);
		return FVector2D(W * FMath::Cos(A) * N, 1.0 + H * PowSafe(FMath::Sin(A), 0.72) * N);
	}
}

void ApexProps::BuildTunnel(const FApexTrackSpline& Spline, FApexPropsResult& Out)
{
	const TArray<TArray<int32>> Runs = ApexMesh::FindRuns(Spline,
		[&Spline](int32 i) { return (Spline.Flags[i] & FApexTrackSpline::FLAG_TUNNEL) != 0; }, 4, 0);
	if (Runs.Num() == 0)
	{
		return;
	}

	FApexMeshGroup& Group = Out.AddGroup(TEXT("Tunnel"), /*bCollision*/ true);
	FApexMeshData& Wall = Group.SectionFor("tunnelWall");
	FApexMeshData& RockFace = Group.SectionFor("rockFace");
	FApexMeshData& Portal = Group.SectionFor("portal");
	FApexMeshData& Strip = Group.SectionFor("tunnelLight");

	constexpr int32 K = 22;
	constexpr double PortalTaper = 0.20;

	for (const TArray<int32>& Run : Runs)
	{
		const int32 N = Run.Num();

		ApexMesh::BuildRibbon(Spline, Run,
			[&Spline](int32 i, int32 /*Row*/, TArray<FApexProfilePoint>& Pts)
			{
				const double Hw = Spline.Width[i];
				Pts.Reset(K + 1);
				for (int32 k = 0; k <= K; ++k)
				{
					const FVector2D P = ArchProfile(Hw, k, K);
					Pts.Add({ P.X, P.Y, static_cast<double>(k) / K * 2.2 });
				}
			}, Wall, 1.0 / 8.0, false, FColor(160, 158, 152));

		ApexMesh::BuildRibbon(Spline, Run,
			[&Spline, N](int32 i, int32 Row, TArray<FApexProfilePoint>& Pts)
			{
				const double Hw = Spline.Width[i];
				const double Taper = PortalTaper + (1.0 - PortalTaper) *
					FMath::Min(SmoothStep(0.0, N * 0.30, Row), SmoothStep(0.0, N * 0.30, N - 1 - Row));
				Pts.Reset(K + 1);
				for (int32 k = 0; k <= K; ++k)
				{
					const FVector2D P = HillProfile(Hw, k, K, Taper, Spline.X[i], Spline.Z[i]);
					Pts.Add({ P.X, P.Y, static_cast<double>(k) / K * 5.0 });
				}
			}, RockFace, 1.0 / 14.0, false, FColor(112, 108, 100));

		// portal facades: quad strip between the arch outline and the hill outline
		for (int32 End : { 0, N - 1 })
		{
			const int32 i = Run[End];
			const double Hw = Spline.Width[i];
			FVector Right, Up, Fwd;
			Spline.FrameAt(i, Right, Up, Fwd);
			const FVector Centre = ApexToUE(Spline.X[i], Spline.Y[i], Spline.Z[i]);

			const int32 Base = Portal.Vertices.Num();
			for (int32 k = 0; k <= K; ++k)
			{
				const FVector2D A = ArchProfile(Hw, k, K);
				const FVector2D H = HillProfile(Hw, k, K, PortalTaper, Spline.X[i], Spline.Z[i]);
				const double U = static_cast<double>(k) / K * 4.0;
				Portal.AddVertex(Centre + Right * (A.X * APEX_TO_UE) + Up * (A.Y * APEX_TO_UE), FVector2D(U, 0), FColor(120, 118, 114));
				Portal.AddVertex(Centre + Right * (H.X * APEX_TO_UE) + Up * (H.Y * APEX_TO_UE), FVector2D(U, 1), FColor(120, 118, 114));
			}
			for (int32 k = 0; k < K; ++k)
			{
				const int32 B = Base + k * 2;
				if (End == 0)
				{
					Portal.AddTriangle(B, B + 1, B + 2);
					Portal.AddTriangle(B + 1, B + 3, B + 2);
				}
				else
				{
					Portal.AddTriangle(B, B + 2, B + 1);
					Portal.AddTriangle(B + 1, B + 2, B + 3);
				}
			}
		}

		// ceiling light strip
		ApexMesh::BuildRibbon(Spline, Run,
			[&Spline](int32 i, int32 /*Row*/, TArray<FApexProfilePoint>& Pts)
			{
				const double Hw = Spline.Width[i];
				const FVector2D P = ArchProfile(Hw, K / 2, K);
				Pts.Reset(2);
				Pts.Add({ -0.55, P.Y - 0.28, 0.0 });
				Pts.Add({ 0.55, P.Y - 0.28, 1.0 });
			}, Strip, 1.0 / 6.0);

		const double PerSample = Spline.Length / Spline.Count;
		const int32 LightStep = FMath::Max(3, FMath::RoundToInt32(26.0 / PerSample));
		for (int32 k = 0; k < N; k += LightStep)
		{
			const int32 i = Run[k];
			Out.TunnelLights.Add(ApexToUE(Spline.X[i], Spline.Y[i] + 5.4, Spline.Z[i]));
		}
	}

	Group.ComputeNormals();
	Group.Compact();
}

void ApexProps::BuildBridge(const FApexTrackSpline& Spline, const FApexTerrain& Terrain, FApexPropsResult& Out)
{
	const TArray<TArray<int32>> Runs = ApexMesh::FindRuns(Spline,
		[&Spline](int32 i) { return (Spline.Flags[i] & FApexTrackSpline::FLAG_BRIDGE) != 0; }, 4, 0);
	if (Runs.Num() == 0)
	{
		return;
	}

	FApexMeshGroup& Group = Out.AddGroup(TEXT("Bridge"), /*bCollision*/ true);
	FApexMeshData& Concrete = Group.SectionFor("concrete");
	FApexMeshData& Steel = Group.SectionFor("steel");

	for (const TArray<int32>& Run : Runs)
	{
		const int32 N = Run.Num();

		// box girder under the deck
		ApexMesh::BuildRibbon(Spline, Run,
			[&Spline](int32 i, int32 /*Row*/, TArray<FApexProfilePoint>& Pts)
			{
				const double Hw = Spline.Width[i] + APEX_SHOULDER;
				Pts.Reset(6);
				Pts.Add({ Hw + 0.5, -0.16, 0.0 });
				Pts.Add({ Hw + 0.1, -1.7, 0.2 });
				Pts.Add({ Hw * 0.55, -2.5, 0.4 });
				Pts.Add({ -Hw * 0.55, -2.5, 0.6 });
				Pts.Add({ -Hw - 0.1, -1.7, 0.8 });
				Pts.Add({ -Hw - 0.5, -0.16, 1.0 });
			}, Concrete, 1.0 / 9.0, false, FColor(150, 150, 152));

		// tied arches either side, with hangers and cross bracing
		constexpr double ArchH = 22.0;
		const double PerSample = Spline.Length / Spline.Count;
		FVector Right, Up, Fwd;

		for (double Side : { 1.0, -1.0 })
		{
			for (int32 k = 0; k + 1 < N; ++k)
			{
				const int32 I0 = Run[k];
				const int32 I1 = Run[k + 1];
				const double T0 = static_cast<double>(k) / (N - 1);
				const double T1 = static_cast<double>(k + 1) / (N - 1);

				Spline.FrameAt(I0, Right, Up, Fwd);
				const double Off0 = Spline.Width[I0] + APEX_SHOULDER + 0.9;
				const FVector P0 = ApexToUE(Spline.X[I0], Spline.Y[I0] + FMath::Sin(T0 * PI) * ArchH, Spline.Z[I0])
					+ Right * (Off0 * Side * APEX_TO_UE);

				Spline.FrameAt(I1, Right, Up, Fwd);
				const double Off1 = Spline.Width[I1] + APEX_SHOULDER + 0.9;
				const FVector P1 = ApexToUE(Spline.X[I1], Spline.Y[I1] + FMath::Sin(T1 * PI) * ArchH, Spline.Z[I1])
					+ Right * (Off1 * Side * APEX_TO_UE);

				const FVector Seg = P1 - P0;
				const double SegLen = Seg.Size();
				if (SegLen < KINDA_SMALL_NUMBER)
				{
					continue;
				}
				Steel.AddCylinder(P0, 42, 42, SegLen, 7,
					FRotationMatrix::MakeFromZ(Seg / SegLen).ToQuat(), FColor(170, 174, 180), false);
			}
		}

		const int32 HangerStep = FMath::Max(2, FMath::RoundToInt32(11.0 / PerSample));
		for (int32 k = HangerStep; k < N - HangerStep; k += HangerStep)
		{
			const int32 i = Run[k];
			const double T = static_cast<double>(k) / (N - 1);
			const double DeckY = Spline.Y[i];
			const double TopY = DeckY + FMath::Sin(T * PI) * ArchH;
			const double H = TopY - DeckY;
			if (H < 2.0)
			{
				continue;
			}
			Spline.FrameAt(i, Right, Up, Fwd);
			const double Off = Spline.Width[i] + APEX_SHOULDER + 0.9;

			for (double Side : { 1.0, -1.0 })
			{
				const FVector Base = ApexToUE(Spline.X[i], DeckY, Spline.Z[i]) + Right * (Off * Side * APEX_TO_UE);
				Steel.AddCylinder(Base, 7.5, 7.5, H * APEX_TO_UE, 5, FQuat::Identity, FColor(180, 184, 190), false);
			}

			if (FMath::Sin(T * PI) > 0.34)
			{
				const FVector Mid = ApexToUE(Spline.X[i], TopY - 0.3, Spline.Z[i]);
				Steel.AddBox(Mid, FVector(15, Off * APEX_TO_UE, 15),
					FRotationMatrix::MakeFromXZ(FVector(Fwd.X, Fwd.Y, 0).GetSafeNormal(), FVector::UpVector).ToQuat(),
					FColor(170, 174, 180));
			}
		}

		// piers down to the canyon floor
		const int32 PierStep = FMath::Max(3, FMath::RoundToInt32(34.0 / PerSample));
		for (int32 k = PierStep; k < N - PierStep / 2; k += PierStep)
		{
			const int32 i = Run[k];
			const double Ground = Terrain.Sample(Spline.X[i], Spline.Z[i]);
			const double Top = Spline.Y[i] - 2.4;
			const double H = Top - Ground;
			if (H < 3.0)
			{
				continue;
			}
			Concrete.AddCylinder(ApexToUE(Spline.X[i], Ground - 1.0, Spline.Z[i]),
				240, 150, (H + 2.0) * APEX_TO_UE, 10, FQuat::Identity, FColor(146, 146, 148));
		}
	}

	Group.ComputeNormals();
	Group.Compact();
}

void ApexProps::BuildStartGantry(const FApexTrackSpline& Spline, int32 StartIndex, FApexPropsResult& Out)
{
	FApexMeshGroup& Group = Out.AddGroup(TEXT("Gantry"));
	FApexMeshData& Steel = Group.SectionFor("steel");
	FApexMeshData& Banner = Group.SectionFor("banner");

	FVector Right, Up, Fwd;
	Spline.FrameAt(StartIndex, Right, Up, Fwd);
	const double Hw = Spline.Width[StartIndex] + APEX_SHOULDER + 1.6;
	const FVector Base = ApexToUE(Spline.X[StartIndex], Spline.Y[StartIndex], Spline.Z[StartIndex]);
	constexpr double LegH = 8.4;

	for (double Side : { 1.0, -1.0 })
	{
		const FVector Leg = Base + Right * (Hw * Side * APEX_TO_UE) + FVector(0, 0, LegH * 0.5 * APEX_TO_UE);
		Steel.AddBox(Leg, FVector(25, 25, LegH * 0.5 * APEX_TO_UE), FQuat::Identity, FColor(180, 184, 190));
	}

	const FQuat AcrossRot = FRotationMatrix::MakeFromXZ(FVector(Right.X, Right.Y, 0).GetSafeNormal(), FVector::UpVector).ToQuat();
	Steel.AddBox(Base + FVector(0, 0, LegH * APEX_TO_UE),
		FVector(Hw * APEX_TO_UE, 27, 37), AcrossRot, FColor(180, 184, 190));

	// banner panel facing oncoming cars
	{
		const FVector Facing = -FVector(Fwd.X, Fwd.Y, 0).GetSafeNormal();
		const FVector Across = FVector::CrossProduct(FVector::UpVector, Facing).GetSafeNormal();
		const FVector Centre = Base + FVector(0, 0, (LegH - 1.25) * APEX_TO_UE);
		const double HalfW = Hw * 0.875 * APEX_TO_UE;
		constexpr double HalfH = 0.95 * APEX_TO_UE;

		const int32 S = Banner.Vertices.Num();
		Banner.AddVertex(Centre - Across * HalfW - FVector(0, 0, HalfH), FVector2D(0, 1), FColor::White);
		Banner.AddVertex(Centre + Across * HalfW - FVector(0, 0, HalfH), FVector2D(1, 1), FColor::White);
		Banner.AddVertex(Centre + Across * HalfW + FVector(0, 0, HalfH), FVector2D(1, 0), FColor::White);
		Banner.AddVertex(Centre - Across * HalfW + FVector(0, 0, HalfH), FVector2D(0, 0), FColor::White);
		Banner.AddQuad(S, S + 1, S + 2, S + 3);
	}

	Group.ComputeNormals();
	Group.Compact();
}
