// Apex Horizon — procedural car bodies.
//
// Each body is lofted from a per-profile silhouette: a run of superellipse rings from
// tail to nose, a narrower greenhouse on top, then bumpers, lights, mirrors and a wing.
// Local frame is Unreal's: +X forward, +Y right, +Z up, origin on the ground between
// the wheels.

#pragma once

#include "CoreMinimal.h"

struct FApexCar;
struct FApexMeshGroup;
struct FApexMeshData;

namespace ApexCarBody
{
	/** Emit the whole body into `Out`, one section per material. */
	APEXHORIZON_API void Build(const FApexCar& Car, FApexMeshGroup& Out);

	/** A single wheel: tyre, rim, brake disc and caliper. Radius/width in metres. */
	APEXHORIZON_API void BuildWheel(double Radius, double Width, int32 RimStyle, FApexMeshGroup& Out);

	/** Simple convex hull used for the chassis collision box, in centimetres. */
	APEXHORIZON_API void GetCollisionExtents(const FApexCar& Car, FVector& OutCenter, FVector& OutHalfExtents);
}
