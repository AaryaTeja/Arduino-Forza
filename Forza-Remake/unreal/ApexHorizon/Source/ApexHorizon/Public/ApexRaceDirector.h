// Apex Horizon — race director.
//
// Grid, countdown, checkpoint validation, lap timing, live placement and results.
// Progress is tracked as continuous arc length, so a car cannot skip a chunk of
// circuit or gain a lap by reversing back over the line.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ApexRaceDirector.generated.h"

class AApexVehiclePawn;
class AApexWorldActor;
class UApexAIDriver;
class UApexMaterialLibrary;
class UProceduralMeshComponent;

UENUM(BlueprintType)
enum class EApexRaceState : uint8
{
	Idle,
	Countdown,
	Running,
	Finished
};

UENUM(BlueprintType)
enum class EApexRaceMode : uint8
{
	Race,
	TimeTrial,
	FreeRoam
};

UENUM()
enum class EApexRaceEventType : uint8
{
	Countdown,
	Go,
	Lap,
	BestLap,
	Checkpoint,
	Finish,
	RaceOver
};

USTRUCT()
struct APEXHORIZON_API FApexRaceEvent
{
	GENERATED_BODY()

	EApexRaceEventType Type = EApexRaceEventType::Go;
	int32 Value = 0;
	double Time = 0.0;
	FString Name;
};

/** One car in the event. */
USTRUCT()
struct APEXHORIZON_API FApexEntrant
{
	GENERATED_BODY()

	UPROPERTY() TObjectPtr<AApexVehiclePawn> Pawn = nullptr;
	UPROPERTY() TObjectPtr<UApexAIDriver> Ai = nullptr;
	UPROPERTY() bool bIsPlayer = false;
	UPROPERTY() FString Name;
	UPROPERTY() FLinearColor Colour = FLinearColor::White;

	int32 Index = 0;
	int32 Lap = 0;
	int32 NextCheckpoint = 0;
	double Progress = 0.0;
	double LastS = 0.0;
	double LapStart = 0.0;
	TArray<double> LapTimes;
	double BestLap = -1.0;
	TArray<double> SectorTimes;
	TArray<double> CurrentSectors;
	bool bFinished = false;
	double FinishTime = -1.0;
	int32 Position = 1;
	double GapToLeader = 0.0;
	double GapAhead = 0.0;
	bool bWrongWay = false;
	double TrackDist = 0.0;
	double HalfWidth = 8.0;
};

UCLASS()
class APEXHORIZON_API AApexRaceDirector : public AActor
{
	GENERATED_BODY()

public:
	AApexRaceDirector();

	void Setup(AApexWorldActor* InWorld, UApexMaterialLibrary* InMaterials,
		const TArray<FApexEntrant>& Entries, int32 InLaps, EApexRaceMode InMode);

	void StartRace(double CountdownSeconds = 3.2);
	virtual void Tick(float DeltaSeconds) override;

	EApexRaceState GetState() const { return State; }
	EApexRaceMode GetMode() const { return Mode; }
	double GetTime() const { return Time; }
	double GetCountdown() const { return Countdown; }
	int32 GetLaps() const { return Laps; }

	/** True once the lights go out; the AI and player are held on the grid until then. */
	bool AllowDrive() const;

	const TArray<FApexEntrant>& GetEntrants() const { return Entrants; }
	const TArray<int32>& GetStandings() const { return Standings; }
	const FApexEntrant* GetPlayer() const;

	/** Metres to the player's next checkpoint. */
	double DistanceToNextCheckpoint() const;

	/** Drain the event queue; the HUD and audio consume these. */
	TArray<FApexRaceEvent> ConsumeEvents();

	void Reset();

private:
	void CheckProgress(FApexEntrant& E, const struct FApexSplineQuery& Q);
	void UpdatePositions();
	void UpdateGates();
	void BuildGates(UApexMaterialLibrary* InMaterials);

	UPROPERTY() TObjectPtr<AApexWorldActor> World = nullptr;
	UPROPERTY() TArray<FApexEntrant> Entrants;
	UPROPERTY() TArray<TObjectPtr<UProceduralMeshComponent>> GatePosts;
	UPROPERTY() TObjectPtr<class UMaterialInstanceDynamic> GateMaterial = nullptr;

	TArray<FApexRaceEvent> Events;
	TArray<int32> Standings;
	TArray<double> Placeholder;

	EApexRaceState State = EApexRaceState::Idle;
	EApexRaceMode Mode = EApexRaceMode::Race;
	int32 Laps = 3;
	int32 SectorCount = 3;
	double Time = 0.0;
	double Countdown = 0.0;
	int32 LastBeep = 4;
	double CheckpointSpacing = 0.0;
};
