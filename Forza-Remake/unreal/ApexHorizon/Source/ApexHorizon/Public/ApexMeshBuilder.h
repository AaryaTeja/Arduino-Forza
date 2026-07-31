// Apex Horizon — CPU-side mesh accumulation, shared by terrain, road and props.
//
// Winding convention: for triangle (A, B, C) the front face points along
// (C - A) ^ (B - A), which is what ProceduralMeshComponent treats as front-facing.
// The Apex → Unreal axis swap in ApexMath reverses orientation, and Unreal's
// front-face convention is likewise reversed relative to three.js, so index orders
// ported straight from the original stay correct.

#pragma once

#include "CoreMinimal.h"
#include "ProceduralMeshComponent.h"

class FApexTrackSpline;

/** One cross-section vertex used when lofting a ribbon along the centreline. */
struct FApexProfilePoint
{
	double X = 0.0;  // lateral offset, metres
	double Y = 0.0;  // vertical offset, metres
	double U = 0.0;  // texture coordinate across the ribbon
};

struct APEXHORIZON_API FApexMeshData
{
	TArray<FVector> Vertices;
	TArray<int32> Triangles;
	TArray<FVector> Normals;
	TArray<FVector2D> UV0;
	TArray<FColor> Colors;
	TArray<FProcMeshTangent> Tangents;

	int32 Num() const { return Vertices.Num(); }
	bool IsEmpty() const { return Triangles.Num() == 0; }

	void Reset()
	{
		Vertices.Reset(); Triangles.Reset(); Normals.Reset();
		UV0.Reset(); Colors.Reset(); Tangents.Reset();
	}

	void Reserve(int32 VertexCount, int32 TriangleCount)
	{
		Vertices.Reserve(VertexCount); Normals.Reserve(VertexCount);
		UV0.Reserve(VertexCount); Colors.Reserve(VertexCount);
		Triangles.Reserve(TriangleCount * 3);
	}

	/** Append a vertex in Unreal space, returning its index. */
	int32 AddVertex(const FVector& P, const FVector2D& Uv, const FColor& C = FColor::White)
	{
		Vertices.Add(P);
		UV0.Add(Uv);
		Colors.Add(C);
		Normals.Add(FVector::ZeroVector);
		return Vertices.Num() - 1;
	}

	void AddTriangle(int32 A, int32 B, int32 C)
	{
		Triangles.Add(A); Triangles.Add(B); Triangles.Add(C);
	}

	void AddQuad(int32 A, int32 B, int32 C, int32 D)
	{
		AddTriangle(A, B, C);
		AddTriangle(A, C, D);
	}

	/** Merge another buffer, offsetting its indices. */
	void Append(const FApexMeshData& Other);

	/** Area-weighted smooth normals, plus tangents derived from UVs. */
	void ComputeNormals();

	/** Flat-shaded normals; duplicates nothing, just averages per face into shared verts. */
	void ComputeFlatNormals();

	/**
	 * Axis-aligned-then-rotated box. `HalfExtents` is in Unreal centimetres.
	 * UV scale is in world centimetres per tile.
	 */
	void AddBox(const FVector& Center, const FVector& HalfExtents, const FQuat& Rotation,
		const FColor& C = FColor::White, double UvScale = 200.0);

	/** Vertical prism from a convex XY polygon extruded along +Z. */
	void AddPrism(const TArray<FVector2D>& Poly, double BaseZ, double TopZ,
		const FColor& C = FColor::White, double UvScale = 200.0, bool bCapTop = true);

	/** Tapered cylinder along the local +Z of `Rotation`. */
	void AddCylinder(const FVector& Base, double RadiusBottom, double RadiusTop, double Height,
		int32 Sides, const FQuat& Rotation, const FColor& C = FColor::White, bool bCaps = true);

	/** Low-poly sphere/ellipsoid, used for tree canopies. */
	void AddEllipsoid(const FVector& Center, const FVector& Radii, int32 Segments, int32 Rings,
		const FColor& C = FColor::White);

	/**
	 * Drop any triangle with a non-finite vertex, and report how many went.
	 * Collision cooking turns a single NaN vertex into a corrupt BVH for the whole
	 * mesh, so this runs before anything reaches the physics engine.
	 */
	int32 SanitiseNonFinite(const TCHAR* Context);

	/** Push into a ProceduralMeshComponent section. */
	void ToSection(UProceduralMeshComponent* Component, int32 SectionIndex, bool bCreateCollision) const;
};

/**
 * One ProceduralMeshComponent's worth of geometry: several sections, each with its own
 * material. Grouping by locality rather than by material keeps frustum culling useful.
 */
struct APEXHORIZON_API FApexMeshGroup
{
	FString Name;
	/**
	 * Held by pointer, not by value: callers routinely hold references to several
	 * sections at once while filling them, and a TArray of values would move its
	 * elements out from under those references as it grows.
	 */
	TArray<TUniquePtr<FApexMeshData>> Sections;
	TArray<FName> SectionMaterials;
	bool bCollision = false;
	bool bCastShadow = true;

	/** Get (creating if needed) the section that uses `Material`. */
	FApexMeshData& SectionFor(FName Material)
	{
		const int32 Existing = SectionMaterials.IndexOfByKey(Material);
		if (Existing != INDEX_NONE)
		{
			return *Sections[Existing];
		}
		SectionMaterials.Add(Material);
		return *Sections.Add_GetRef(MakeUnique<FApexMeshData>());
	}

	int32 NumSections() const { return Sections.Num(); }
	FApexMeshData& SectionAt(int32 Index) { return *Sections[Index]; }
	const FApexMeshData& SectionAt(int32 Index) const { return *Sections[Index]; }

	/** Recompute normals and tangents for every section. */
	void ComputeNormals()
	{
		for (TUniquePtr<FApexMeshData>& Section : Sections)
		{
			Section->ComputeNormals();
		}
	}

	/** Drop empty sections so no zero-triangle sections reach the renderer. */
	void Compact()
	{
		for (int32 i = Sections.Num() - 1; i >= 0; --i)
		{
			if (Sections[i]->IsEmpty())
			{
				Sections.RemoveAt(i);
				SectionMaterials.RemoveAt(i);
			}
		}
	}

	bool IsEmpty() const { return Sections.Num() == 0; }
};

namespace ApexMesh
{
	/**
	 * Loft a cross-section along a run of spline samples.
	 * @param ProfileFn (SplineIndex, Row) -> cross-section in the local (right, up) frame.
	 */
	APEXHORIZON_API void BuildRibbon(
		const FApexTrackSpline& Spline,
		const TArray<int32>& Indices,
		TFunctionRef<void(int32 /*SplineIndex*/, int32 /*Row*/, TArray<FApexProfilePoint>&)> ProfileFn,
		FApexMeshData& Out,
		double VScale = 1.0 / 24.0,
		bool bClosed = false,
		const FColor& Colour = FColor::White);

	/** Contiguous index runs (with wrap) where Predicate holds. */
	APEXHORIZON_API TArray<TArray<int32>> FindRuns(
		const FApexTrackSpline& Spline,
		TFunctionRef<bool(int32)> Predicate,
		int32 MinLen = 3,
		int32 Pad = 0);

	/** Fade a lofted run in and out so it does not start or stop abruptly. */
	APEXHORIZON_API double RunTaper(int32 RunLength, int32 Row);

	/**
	 * Split a group into a spatial grid, appending the non-empty chunks to `Out`.
	 *
	 * A primitive's bounds decide what the renderer can cull, and under virtual shadow
	 * maps they decide how many shadow pages it has to be rendered into. A single
	 * component holding the whole 4.7 km of barriers or street furniture overlaps
	 * essentially every page, so it gets drawn over and over; chunking it into a few
	 * hundred metres each is the difference between about 1 fps and a playable frame
	 * rate. Triangles are assigned by centroid, and vertices are shared within a chunk.
	 */
	APEXHORIZON_API void SplitIntoChunks(const FApexMeshGroup& Source, double ChunkSizeCm,
		TArray<FApexMeshGroup>& Out);
}
