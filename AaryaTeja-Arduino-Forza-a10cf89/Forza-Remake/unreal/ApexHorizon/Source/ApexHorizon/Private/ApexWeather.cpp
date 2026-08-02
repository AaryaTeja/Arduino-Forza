// Apex Horizon — sky, sun, weather and time of day.

#include "ApexWeather.h"

#include "ApexMaterialLibrary.h"
#include "ApexMath.h"
#include "ApexMeshBuilder.h"
#include "ApexWorldActor.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/PostProcessComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Engine/Engine.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "ProceduralMeshComponent.h"

using namespace ApexMath;

namespace
{
	constexpr int32 RainDrops = 2600;
	constexpr double RainRadius = 2600.0;   // centimetres around the camera
	constexpr double RainHeight = 3200.0;
	constexpr double RainSpeed = 5200.0;    // cm/s
}

AApexWeather::AApexWeather()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

	Sun = CreateDefaultSubobject<UDirectionalLightComponent>(TEXT("Sun"));
	Sun->SetupAttachment(RootComponent);
	Sun->SetMobility(EComponentMobility::Movable);
	Sun->SetIntensity(3.f);
	Sun->SetAtmosphereSunLight(true);
	Sun->bCastVolumetricShadow = true;
	Sun->DynamicShadowDistanceMovableLight = 32000.f;
	Sun->CascadeDistributionExponent = 3.f;
	Sun->SetCastShadows(true);

	Moon = CreateDefaultSubobject<UDirectionalLightComponent>(TEXT("Moon"));
	Moon->SetupAttachment(RootComponent);
	Moon->SetMobility(EComponentMobility::Movable);
	Moon->SetIntensity(0.f);
	Moon->SetLightColor(FLinearColor(0.55f, 0.66f, 0.95f));
	Moon->SetCastShadows(false);

	Atmosphere = CreateDefaultSubobject<USkyAtmosphereComponent>(TEXT("SkyAtmosphere"));
	Atmosphere->SetupAttachment(RootComponent);

	SkyLight = CreateDefaultSubobject<USkyLightComponent>(TEXT("SkyLight"));
	SkyLight->SetupAttachment(RootComponent);
	SkyLight->SetMobility(EComponentMobility::Movable);
	SkyLight->SourceType = ESkyLightSourceType::SLS_CapturedScene;
	SkyLight->bRealTimeCapture = true;
	SkyLight->SetIntensity(1.f);

	Clouds = CreateDefaultSubobject<UVolumetricCloudComponent>(TEXT("VolumetricCloud"));
	Clouds->SetupAttachment(RootComponent);
	Clouds->LayerBottomAltitude = 4.f;
	Clouds->LayerHeight = 6.f;

	Fog = CreateDefaultSubobject<UExponentialHeightFogComponent>(TEXT("HeightFog"));
	Fog->SetupAttachment(RootComponent);
	Fog->SetFogDensity(0.008f);
	Fog->SetFogHeightFalloff(0.08f);
	Fog->SetVolumetricFog(true);
	Fog->SetVolumetricFogScatteringDistribution(0.35f);
	Fog->SetVolumetricFogExtinctionScale(1.f);

	PostProcess = CreateDefaultSubobject<UPostProcessComponent>(TEXT("PostProcess"));
	PostProcess->SetupAttachment(RootComponent);
	PostProcess->bUnbound = true;

	Rain = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("Rain"));
	Rain->SetupAttachment(RootComponent);
	Rain->SetMobility(EComponentMobility::Movable);
	Rain->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Rain->SetCastShadow(false);
	Rain->SetVisibility(false);
	Rain->bNeverDistanceCull = true;
}

void AApexWeather::BeginPlay()
{
	Super::BeginPlay();

	// A tuned baseline grade; the presets adjust exposure and colour on top of this.
	FPostProcessSettings& PP = PostProcess->Settings;
	PP.bOverride_AutoExposureMethod = true;
	PP.AutoExposureMethod = AEM_Histogram;
	PP.bOverride_AutoExposureMinBrightness = true;
	PP.AutoExposureMinBrightness = 0.35f;
	PP.bOverride_AutoExposureMaxBrightness = true;
	PP.AutoExposureMaxBrightness = 3.2f;
	PP.bOverride_AutoExposureSpeedUp = true;
	PP.AutoExposureSpeedUp = 4.f;
	PP.bOverride_AutoExposureSpeedDown = true;
	PP.AutoExposureSpeedDown = 2.f;

	PP.bOverride_BloomIntensity = true;
	PP.BloomIntensity = 0.62f;
	PP.bOverride_BloomThreshold = true;
	PP.BloomThreshold = -0.2f;

	PP.bOverride_MotionBlurAmount = true;
	PP.MotionBlurAmount = 0.35f;
	PP.bOverride_MotionBlurMax = true;
	PP.MotionBlurMax = 6.f;

	PP.bOverride_FilmGrainIntensity = true;
	PP.FilmGrainIntensity = 0.06f;

	PP.bOverride_ToneCurveAmount = true;
	PP.ToneCurveAmount = 1.f;
	PP.bOverride_ColorSaturation = true;
	PP.ColorSaturation = FVector4(1.06f, 1.06f, 1.06f, 1.f);
	PP.bOverride_ColorContrast = true;
	PP.ColorContrast = FVector4(1.04f, 1.04f, 1.04f, 1.f);

	PP.bOverride_AmbientOcclusionIntensity = true;
	PP.AmbientOcclusionIntensity = 0.5f;

	PP.bOverride_LensFlareIntensity = true;
	PP.LensFlareIntensity = 0.35f;

	BuildRainMesh();
	ApplyTimeOfDay();
	ApplyPreset();
	Wetness = TargetWetness;
}

void AApexWeather::Configure(AApexWorldActor* InWorld, EApexWeatherPreset InPreset,
	EApexTimeOfDay InTime, bool bInAdvanceTime)
{
	World = InWorld;
	Preset = InPreset;
	bAdvanceTime = bInAdvanceTime;

	switch (InTime)
	{
	case EApexTimeOfDay::Dawn:   TimeOfDayHours = 6.4f; break;
	case EApexTimeOfDay::Sunset: TimeOfDayHours = 19.2f; break;
	case EApexTimeOfDay::Night:  TimeOfDayHours = 22.5f; break;
	default:                     TimeOfDayHours = 13.0f; break;
	}

	ApplyTimeOfDay();
	ApplyPreset();
	Wetness = TargetWetness;
}

bool AApexWeather::IsNight() const
{
	return TimeOfDayHours < 6.0f || TimeOfDayHours > 19.6f;
}

void AApexWeather::SetTimeOfDayHours(float Hours)
{
	TimeOfDayHours = FMath::Fmod(FMath::Fmod(Hours, 24.f) + 24.f, 24.f);
	ApplyTimeOfDay();
}

void AApexWeather::SetPreset(EApexWeatherPreset InPreset)
{
	Preset = InPreset;
	ApplyPreset();
}

void AApexWeather::ApplyTimeOfDay()
{
	// Sun elevation over the day: noon high, dawn/dusk grazing, night below the horizon.
	const double DayFraction = (TimeOfDayHours - 6.0) / 12.0;      // 0 at 06:00, 1 at 18:00
	const double Elevation = FMath::Sin(DayFraction * PI) * 68.0 - 2.0;
	const double Azimuth = 40.0 + TimeOfDayHours * 12.0;

	Sun->SetWorldRotation(FRotator(static_cast<float>(-Elevation), static_cast<float>(Azimuth), 0.f));
	Moon->SetWorldRotation(FRotator(static_cast<float>(Elevation), static_cast<float>(Azimuth + 180.0), 0.f));

	// Warm and dim near the horizon, neutral and bright at midday.
	const double Height = Clamp01((Elevation + 2.0) / 60.0);
	const FLinearColor Warm(1.0f, 0.62f, 0.36f);
	const FLinearColor Neutral(1.0f, 0.96f, 0.92f);
	Sun->SetLightColor(FMath::Lerp(Warm, Neutral, static_cast<float>(FMath::Pow(Height, 0.55))));

	const float SunIntensity = static_cast<float>(Lerp(0.0, 9.0, FMath::Pow(Height, 0.8)));
	Sun->SetIntensity(SunIntensity);
	Sun->SetVisibility(SunIntensity > 0.001f);

	const bool bNight = IsNight();
	Moon->SetIntensity(bNight ? 0.09f : 0.f);
	Moon->SetVisibility(bNight);

	SkyLight->SetIntensity(bNight ? 0.55f : 1.0f);
	if (SkyLight->IsRegistered())
	{
		SkyLight->RecaptureSky();
	}

	if (World && bWasNight != bNight)
	{
		bWasNight = bNight;
		World->SetNightLighting(bNight);
	}

	if (PostProcess)
	{
		PostProcess->Settings.bOverride_AutoExposureBias = true;
		PostProcess->Settings.AutoExposureBias = bNight ? 1.6f : 0.6f;
	}
}

void AApexWeather::ApplyPreset()
{
	switch (Preset)
	{
	case EApexWeatherPreset::Clear:
		TargetWetness = 0.f;
		Fog->SetFogDensity(0.006f);
		Fog->SetFogInscatteringColor(FLinearColor(0.42f, 0.56f, 0.78f));
		Fog->SetVolumetricFogExtinctionScale(0.8f);
		Clouds->SetVisibility(true);
		Clouds->LayerHeight = 5.f;
		break;

	case EApexWeatherPreset::Overcast:
		TargetWetness = 0.12f;
		Fog->SetFogDensity(0.016f);
		Fog->SetFogInscatteringColor(FLinearColor(0.48f, 0.52f, 0.58f));
		Fog->SetVolumetricFogExtinctionScale(1.4f);
		Clouds->SetVisibility(true);
		Clouds->LayerHeight = 9.f;
		break;

	case EApexWeatherPreset::Rain:
		TargetWetness = 1.f;
		Fog->SetFogDensity(0.028f);
		Fog->SetFogInscatteringColor(FLinearColor(0.38f, 0.42f, 0.50f));
		Fog->SetVolumetricFogExtinctionScale(1.9f);
		Clouds->SetVisibility(true);
		Clouds->LayerHeight = 11.f;
		break;

	case EApexWeatherPreset::Fog:
		TargetWetness = 0.35f;
		Fog->SetFogDensity(0.075f);
		Fog->SetFogInscatteringColor(FLinearColor(0.62f, 0.64f, 0.68f));
		Fog->SetVolumetricFogExtinctionScale(3.2f);
		Clouds->SetVisibility(true);
		Clouds->LayerHeight = 7.f;
		break;
	}

	if (Rain)
	{
		Rain->SetVisibility(Preset == EApexWeatherPreset::Rain);
	}
}

void AApexWeather::BuildRainMesh()
{
	FApexMeshData Mesh;
	Mesh.Reserve(RainDrops * 4, RainDrops * 2);

	FRng Rng(0x9a11);
	for (int32 i = 0; i < RainDrops; ++i)
	{
		// uniform disc sampling so drops aren't bunched at the centre
		const double R = RainRadius * FMath::Sqrt(Rng());
		const double A = Rng() * 2.0 * PI;
		const double X = R * FMath::Cos(A);
		const double Y = R * FMath::Sin(A);
		const double Z = Rng() * RainHeight;

		constexpr double Streak = 46.0;
		constexpr double Wide = 1.6;

		const int32 Base = Mesh.Vertices.Num();
		Mesh.AddVertex(FVector(X - Wide, Y, Z), FVector2D(0, 0), FColor::White);
		Mesh.AddVertex(FVector(X + Wide, Y, Z), FVector2D(1, 0), FColor::White);
		Mesh.AddVertex(FVector(X + Wide, Y, Z + Streak), FVector2D(1, 1), FColor::White);
		Mesh.AddVertex(FVector(X - Wide, Y, Z + Streak), FVector2D(0, 1), FColor::White);
		Mesh.AddQuad(Base, Base + 1, Base + 2, Base + 3);
	}
	Mesh.ComputeNormals();
	Mesh.ToSection(Rain, 0, false);

	if (UMaterialInterface* Master = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/Materials/M_ApexEmissive.M_ApexEmissive")))
	{
		RainMaterial = UMaterialInstanceDynamic::Create(Master, this);
		if (RainMaterial)
		{
			RainMaterial->SetVectorParameterValue("EmissiveColor", FLinearColor(0.55f, 0.62f, 0.72f));
			RainMaterial->SetScalarParameterValue("EmissiveStrength", 1.4f);
			Rain->SetMaterial(0, RainMaterial);
		}
	}
}

void AApexWeather::UpdateRain(float DeltaSeconds)
{
	if (!Rain || !Rain->IsVisible())
	{
		return;
	}

	// The column follows the camera and slides downward, wrapping every RainHeight.
	RainFallOffset = FMath::Fmod(RainFallOffset + RainSpeed * DeltaSeconds, static_cast<float>(RainHeight));

	FVector CameraPos = FVector::ZeroVector;
	FRotator CameraRot = FRotator::ZeroRotator;
	if (APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0))
	{
		PC->GetPlayerViewPoint(CameraPos, CameraRot);
	}

	Rain->SetWorldLocation(FVector(
		CameraPos.X,
		CameraPos.Y,
		CameraPos.Z - RainHeight * 0.5 - RainFallOffset));
}

void AApexWeather::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	if (bAdvanceTime)
	{
		// a full day passes over about twenty minutes of racing
		SetTimeOfDayHours(TimeOfDayHours + DeltaSeconds * (24.f / 1200.f));
	}

	Wetness = static_cast<float>(Damp(Wetness, TargetWetness, 0.35, DeltaSeconds));
	if (World)
	{
		World->Wetness = Wetness;
	}

	UpdateRain(DeltaSeconds);
}
