// Apex Horizon — the static world: spline, terrain, road, props and their colliders,
// plus the surface queries the vehicles and AI depend on.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ApexTrackSpline.h"
#include "ApexWorldActor.generated.h"

class FApexTerrain;
class UApexMaterialLibrary;
class UProceduralMeshComponent;
class UPointLightComponent;
class USpotLightComponent;

/** One timing gate around the circuit. Positions are Unreal space. */
USTRUCT()
struct APEXHORIZON_API FApexCheckpoint
{
	GENERATED_BODY()

	int32 Index = 0;
	double S = 0.0;
	int32 SplineIndex = 0;
	FVector Position = FVector::ZeroVector;
	FVector Right = FVector::RightVector;
	FVector Up = FVector::UpVector;
	FVector Forward = FVector::ForwardVector;
	double HalfWidth = 8.0;
	bool bIsFinish = false;
};

/** A place on the grid, or a respawn point. */
struct APEXHORIZON_API FApexPlacement
{
	FVector Location = FVector::ZeroVector;
	FRotator Rotation = FRotator::ZeroRotator;
	double S = 0.0;
};

UCLASS()
class APEXHORIZON_API AApexWorldActor : public AActor
{
	GENERATED_BODY()

public:
	AApexWorldActor();

	/** Generate the whole world. `PropDensity` scales tree and building counts. */
	void BuildWorld(UApexMaterialLibrary* InMaterials, double PropDensity = 1.0);

	bool IsBuilt() const { return bBuilt; }

	// ── queries ───────────────────────────────────────────────────────────────────

	/** Surface classification used by tyre grip and the AI. Apex-space metres in. */
	FApexSplineQuery QuerySurface(double X, double Z) const;

	/** Same, from an Unreal-space world position. */
	FApexSplineQuery QuerySurfaceUE(const FVector& WorldPos) const;

	double GroundHeight(double X, double Z) const;

	/** Grid slots behind the start line: two staggered columns. */
	TArray<FApexPlacement> GridSlots(int32 Count) const;

	/** Nearest safe spot on the road, facing the right way. */
	FApexPlacement RespawnPoint(const FVector& WorldPos, double BackOff = 6.0) const;

	/** Point on the racing line at arc length S with a lateral bias, in Unreal space. */
	FVector LinePoint(double S, double Bias) const;

	/** Racing-line target speed at arc length S, m/s. */
	double LineSpeedAt(double S) const;

	/** Lateral offset of the racing line at a spline sample, metres. */
	double GetLineOffset(int32 SplineIndex) const
	{
		return LineOffset.IsValidIndex(SplineIndex) ? LineOffset[SplineIndex] : 0.0;
	}

	const FApexTrackSpline& GetSpline() const { return *Spline; }
	const FApexTerrain& GetTerrain() const { return *Terrain; }
	const TArray<FApexCheckpoint>& GetCheckpoints() const { return Checkpoints; }
	int32 GetStartIndex() const { return StartIndex; }

	/** 0 = dry, 1 = soaked. Drives tyre grip and the look of the tarmac. */
	UPROPERTY(BlueprintReadWrite, Category = "Apex")
	float Wetness = 0.f;

	/** Turn the street and tunnel lighting on or off with the time of day. */
	void SetNightLighting(bool bOn);

	int32 GetTreeCount() const { return TreeCount; }
	int32 GetBuildingCount() const { return BuildingCount; }

private:
	void CreateMeshComponents(TArray<struct FApexMeshGroup>& Groups);
	void CreateColliders(const TArray<struct FApexBoxCollider>& Boxes,
		const TArray<struct FApexCapsuleCollider>& Capsules);
	void CreateWorldBounds();
	void CreateLights(const TArray<FVector>& StreetLamps, const TArray<FVector>& TunnelLights);

	int32 FindStraightest() const;
	void BuildCheckpoints();
	void BuildRacingLine();

	TSharedPtr<FApexTrackSpline> Spline;
	TSharedPtr<FApexTerrain> Terrain;

	UPROPERTY() TObjectPtr<UApexMaterialLibrary> Materials = nullptr;
	UPROPERTY() TArray<TObjectPtr<UProceduralMeshComponent>> MeshComponents;
	UPROPERTY() TArray<TObjectPtr<USpotLightComponent>> StreetLights;
	UPROPERTY() TArray<TObjectPtr<UPointLightComponent>> TunnelLightComponents;

	TArray<FApexCheckpoint> Checkpoints;
	/** Lateral offsets that straighten the corners, and the speed profile along them. */
	TArray<double> LineOffset;
	TArray<double> LineTargetSpeed;

	int32 StartIndex = 0;
	int32 TunnelAnchorIndex = 0;
	int32 TreeCount = 0;
	int32 BuildingCount = 0;
	bool bBuilt = false;
};
