// Apex Horizon — city, vegetation, street furniture, bridge, tunnel and gantry.

#pragma once

#include "CoreMinimal.h"
#include "ApexMeshBuilder.h"
#include "ApexRoadBuilder.h"

class FApexTrackSpline;
class FApexTerrain;

/** Capsule collider used for tree trunks near the racing surface. */
struct APEXHORIZON_API FApexCapsuleCollider
{
	FVector Center = FVector::ZeroVector;  // Unreal space, centimetres
	float Radius = 24.f;
	float HalfHeight = 120.f;
};

/** Everything the prop pass produces, ready to be turned into components. */
struct APEXHORIZON_API FApexPropsResult
{
	TArray<FApexMeshGroup> Groups;
	TArray<FApexBoxCollider> BoxColliders;
	TArray<FApexCapsuleCollider> CapsuleColliders;

	/** World-space positions for the lights the renderer should place. */
	TArray<FVector> StreetLamps;
	TArray<FVector> TunnelLights;

	int32 TreeCount = 0;
	int32 BuildingCount = 0;

	FApexMeshGroup& AddGroup(const FString& Name, bool bCollision = false)
	{
		FApexMeshGroup& G = Groups.AddDefaulted_GetRef();
		G.Name = Name;
		G.bCollision = bCollision;
		return G;
	}
};

namespace ApexProps
{
	/** Blocks of towers around the city basin, plus their box colliders. */
	APEXHORIZON_API void BuildCity(const FApexTrackSpline& Spline, const FApexTerrain& Terrain,
		double Density, FApexPropsResult& Out);

	/** Trees, bushes and rocks, chunked spatially so culling stays useful. */
	APEXHORIZON_API void BuildVegetation(const FApexTrackSpline& Spline, const FApexTerrain& Terrain,
		double Density, FApexPropsResult& Out);

	/** Street lamps, corner marker boards and roadside fencing. */
	APEXHORIZON_API void BuildStreetFurniture(const FApexTrackSpline& Spline, const FApexTerrain& Terrain,
		double Density, FApexPropsResult& Out);

	/** Bored tunnel through the eastern hill: arch lining, hillside, portals, light strip. */
	APEXHORIZON_API void BuildTunnel(const FApexTrackSpline& Spline, FApexPropsResult& Out);

	/** Tied-arch bridge over the river gorge. */
	APEXHORIZON_API void BuildBridge(const FApexTrackSpline& Spline, const FApexTerrain& Terrain,
		FApexPropsResult& Out);

	/** Start/finish gantry straddling the line. */
	APEXHORIZON_API void BuildStartGantry(const FApexTrackSpline& Spline, int32 StartIndex,
		FApexPropsResult& Out);
}
