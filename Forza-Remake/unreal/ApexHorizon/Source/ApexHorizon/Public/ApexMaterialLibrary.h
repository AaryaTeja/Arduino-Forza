// Apex Horizon — the surface palette.
//
// A handful of master materials are generated as assets by Tools/generate_assets.py;
// every surface in the game is a dynamic instance of one of them with different
// parameters, so there are no per-surface material assets to author or ship. If the
// masters are missing the library falls back to an engine material so the project
// still runs.

#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "ApexMaterialLibrary.generated.h"

class UMaterialInterface;
class UMaterialInstanceDynamic;

UCLASS()
class APEXHORIZON_API UApexMaterialLibrary : public UObject
{
	GENERATED_BODY()

public:
	/** Load the masters and build the palette. Safe to call more than once. */
	void Initialise();

	/** Material for a surface key ("road", "terrain", "bark", …). Never null. */
	UMaterialInterface* Get(FName Key);

	/** A fresh car-paint instance for one vehicle. */
	UMaterialInstanceDynamic* CreateCarPaint(const FLinearColor& Colour, int32 Finish, bool bStripes);

	/** A fresh emissive instance, for brake discs and headlights. */
	UMaterialInstanceDynamic* CreateEmissive(const FLinearColor& Colour, float Strength);

	UMaterialInterface* GetGlass() const { return Glass; }
	bool bUsedFallback = false;

private:
	UMaterialInterface* LoadMaster(const TCHAR* Path);

	UMaterialInstanceDynamic* MakeSurface(const FLinearColor& Tint, float Roughness, float Metallic,
		float VertexColourAmount = 1.f, float Specular = 0.5f);

	UPROPERTY() TObjectPtr<UMaterialInterface> SurfaceMaster = nullptr;
	UPROPERTY() TObjectPtr<UMaterialInterface> CarPaintMaster = nullptr;
	UPROPERTY() TObjectPtr<UMaterialInterface> GlassMaster = nullptr;
	UPROPERTY() TObjectPtr<UMaterialInterface> WaterMaster = nullptr;
	UPROPERTY() TObjectPtr<UMaterialInterface> EmissiveMaster = nullptr;

	UPROPERTY() TObjectPtr<UMaterialInterface> Glass = nullptr;
	UPROPERTY() TMap<FName, TObjectPtr<UMaterialInterface>> Palette;
};
