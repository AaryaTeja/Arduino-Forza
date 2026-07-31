// Apex Horizon — tarmac, kerbs, sidewalks, barriers and the start line.

#pragma once

#include "CoreMinimal.h"
#include "ApexMeshBuilder.h"

class FApexTrackSpline;
class FApexTerrain;

/** Half-width of the shoulder either side of the tarmac, metres. */
static constexpr double APEX_SHOULDER = 1.35;

/** An oriented box collider emitted alongside the visual mesh. */
struct APEXHORIZON_API FApexBoxCollider
{
	FVector Center = FVector::ZeroVector;      // Unreal space, centimetres
	FVector HalfExtents = FVector::ZeroVector; // Unreal space, centimetres
	FQuat Rotation = FQuat::Identity;
	float Friction = 0.5f;
	float Restitution = 0.1f;
};

/** A single instanced prop placement (Armco posts, street furniture, trees). */
struct APEXHORIZON_API FApexInstance
{
	FTransform Transform;
	FLinearColor Tint = FLinearColor::White;
};

class APEXHORIZON_API FApexRoadBuilder
{
public:
	FApexRoadBuilder(const FApexTrackSpline& InSpline, const FApexTerrain& InTerrain);

	/** Main tarmac surface, including shoulders. */
	void BuildRoad(FApexMeshData& Out) const;

	/** Red/white kerbs on the apex side of quick corners. */
	void BuildKerbs(FApexMeshData& Out) const;

	/** Raised concrete sidewalks through the city district. */
	void BuildSidewalks(FApexMeshData& Out) const;

	/**
	 * Barriers: concrete on the bridge, Armco where the ground falls away.
	 * The visual is a lofted ribbon; physics is a chain of oriented boxes so nothing
	 * can tunnel through at speed.
	 */
	void BuildBarriers(FApexMeshData& OutConcrete, FApexMeshData& OutMetal,
		TArray<FApexBoxCollider>& OutColliders, TArray<FApexInstance>& OutPosts) const;

	/** Painted start/finish line across the road. */
	void BuildStartLine(int32 StartIndex, FApexMeshData& Out) const;

private:
	const FApexTrackSpline& Spline;
	const FApexTerrain& Terrain;
};
