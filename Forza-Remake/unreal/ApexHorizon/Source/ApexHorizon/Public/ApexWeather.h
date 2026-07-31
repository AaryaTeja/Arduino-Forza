// Apex Horizon — sky, sun, weather and time of day.
//
// Drives a physically-based sky/atmosphere, volumetric cloud and fog stack, plus the
// wetness value the tyre model reads. Rain is a ring of streak quads that follows the
// camera, which is cheap and reads correctly at speed.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ApexWeather.generated.h"

class AApexWorldActor;
class UDirectionalLightComponent;
class UExponentialHeightFogComponent;
class UPostProcessComponent;
class UProceduralMeshComponent;
class USkyAtmosphereComponent;
class USkyLightComponent;
class UVolumetricCloudComponent;

UENUM(BlueprintType)
enum class EApexWeatherPreset : uint8
{
	Clear,
	Overcast,
	Rain,
	Fog
};

UENUM(BlueprintType)
enum class EApexTimeOfDay : uint8
{
	Dawn,
	Noon,
	Sunset,
	Night
};

UCLASS()
class APEXHORIZON_API AApexWeather : public AActor
{
	GENERATED_BODY()

public:
	AApexWeather();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	void Configure(AApexWorldActor* InWorld, EApexWeatherPreset InPreset, EApexTimeOfDay InTime, bool bInAdvanceTime);

	/** Hours, 0–24. Setting this re-poses the sun and re-grades the sky. */
	void SetTimeOfDayHours(float Hours);
	float GetTimeOfDayHours() const { return TimeOfDayHours; }

	void SetPreset(EApexWeatherPreset InPreset);
	EApexWeatherPreset GetPreset() const { return Preset; }

	/** 0 dry, 1 soaked. Ramps toward the preset's target rather than snapping. */
	float GetWetness() const { return Wetness; }

	bool IsNight() const;

private:
	void ApplyTimeOfDay();
	void ApplyPreset();
	void BuildRainMesh();
	void UpdateRain(float DeltaSeconds);

	UPROPERTY() TObjectPtr<UDirectionalLightComponent> Sun = nullptr;
	UPROPERTY() TObjectPtr<UDirectionalLightComponent> Moon = nullptr;
	UPROPERTY() TObjectPtr<USkyLightComponent> SkyLight = nullptr;
	UPROPERTY() TObjectPtr<USkyAtmosphereComponent> Atmosphere = nullptr;
	UPROPERTY() TObjectPtr<UVolumetricCloudComponent> Clouds = nullptr;
	UPROPERTY() TObjectPtr<UExponentialHeightFogComponent> Fog = nullptr;
	UPROPERTY() TObjectPtr<UPostProcessComponent> PostProcess = nullptr;
	UPROPERTY() TObjectPtr<UProceduralMeshComponent> Rain = nullptr;
	UPROPERTY() TObjectPtr<class UMaterialInstanceDynamic> RainMaterial = nullptr;

	UPROPERTY() TObjectPtr<AApexWorldActor> World = nullptr;

	EApexWeatherPreset Preset = EApexWeatherPreset::Clear;
	float TimeOfDayHours = 12.f;
	float TargetWetness = 0.f;
	float Wetness = 0.f;
	bool bAdvanceTime = false;
	bool bWasNight = false;

	/** Height the rain column is re-seeded from, in centimetres. */
	float RainFallOffset = 0.f;
};
