// Apex Horizon — game mode, player controller and HUD.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/HUD.h"
#include "GameFramework/PlayerController.h"
#include "ApexCarData.h"
#include "ApexRaceDirector.h"
#include "ApexWeather.h"
#include "ApexGameMode.generated.h"

class AApexVehiclePawn;
class AApexWorldActor;
class UApexAIDriver;
class UApexMaterialLibrary;

UCLASS(config = Game)
class APEXHORIZON_API AApexGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AApexGameMode();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	AApexWorldActor* GetWorldActor() const { return WorldActor; }
	AApexRaceDirector* GetRaceDirector() const { return RaceDirector; }
	AApexWeather* GetWeather() const { return Weather; }
	AApexVehiclePawn* GetPlayerVehicle() const { return PlayerVehicle; }

	/** Rebuild the field and start a new event with the current settings. */
	UFUNCTION(BlueprintCallable, Category = "Apex")
	void RestartEvent();

	/** Latest banner text for the HUD, e.g. the countdown or "GO". */
	const FString& GetBannerText() const { return BannerText; }
	float GetBannerTimeLeft() const { return BannerTimer; }

	// ── event configuration, editable in DefaultGame.ini ──────────────────────────

	UPROPERTY(config, EditAnywhere, Category = "Apex|Event")
	int32 RivalCount = 7;

	UPROPERTY(config, EditAnywhere, Category = "Apex|Event")
	int32 Laps = 3;

	UPROPERTY(config, EditAnywhere, Category = "Apex|Event")
	EApexRaceMode Mode = EApexRaceMode::Race;

	UPROPERTY(config, EditAnywhere, Category = "Apex|Event")
	FName PlayerCarId = "vulcan";

	UPROPERTY(config, EditAnywhere, Category = "Apex|Event")
	FName PlayerTyreId = "sport";

	UPROPERTY(config, EditAnywhere, Category = "Apex|Weather")
	EApexWeatherPreset WeatherPreset = EApexWeatherPreset::Clear;

	UPROPERTY(config, EditAnywhere, Category = "Apex|Weather")
	EApexTimeOfDay TimeOfDay = EApexTimeOfDay::Noon;

	UPROPERTY(config, EditAnywhere, Category = "Apex|Weather")
	bool bAdvanceTimeDuringRace = false;

	/** Scales tree and building counts. 1.0 is the full world. */
	UPROPERTY(config, EditAnywhere, Category = "Apex|Quality")
	float PropDensity = 1.f;

private:
	AApexVehiclePawn* SpawnVehicle(const FApexBuild& Build, const FTransform& At, bool bIsPlayer);
	void BuildField();
	void HandleRaceEvents();

	UPROPERTY() TObjectPtr<UApexMaterialLibrary> Materials = nullptr;
	UPROPERTY() TObjectPtr<AApexWorldActor> WorldActor = nullptr;
	UPROPERTY() TObjectPtr<AApexRaceDirector> RaceDirector = nullptr;
	UPROPERTY() TObjectPtr<AApexWeather> Weather = nullptr;
	UPROPERTY() TObjectPtr<AApexVehiclePawn> PlayerVehicle = nullptr;
	UPROPERTY() TArray<TObjectPtr<AApexVehiclePawn>> AllVehicles;
	UPROPERTY() TArray<TObjectPtr<UApexAIDriver>> AiDrivers;

	FString BannerText;
	float BannerTimer = 0.f;
};

UCLASS()
class APEXHORIZON_API AApexPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	AApexPlayerController();

	virtual void BeginPlay() override;
	virtual void PlayerTick(float DeltaSeconds) override;

private:
	void PollDriving(float DeltaSeconds);
	void PollActions();

	/** Smoothed keyboard steering, so digital keys don't snap the wheels to full lock. */
	float SteerAxis = 0.f;
	bool bPrevShiftUp = false;
	bool bPrevShiftDown = false;
};

UCLASS()
class APEXHORIZON_API AApexHUD : public AHUD
{
	GENERATED_BODY()

public:
	virtual void DrawHUD() override;

private:
	void DrawTachometer(const struct FApexTelemetry& T, const FApexSpec& Spec, float X, float Y, float Radius);
	void DrawRaceInfo(class AApexGameMode* GameMode, float Width, float Height);
	void DrawStandings(class AApexRaceDirector* Race, float Width, float Height);
	void DrawMinimap(class AApexGameMode* GameMode, float X, float Y, float Size);
	void DrawBanner(class AApexGameMode* GameMode, float Width, float Height);

	void Panel(float X, float Y, float W, float H, float Alpha = 0.55f);
	void Label(const FString& Text, float X, float Y, const FLinearColor& Colour, float Scale = 1.f, bool bLarge = false);
};
