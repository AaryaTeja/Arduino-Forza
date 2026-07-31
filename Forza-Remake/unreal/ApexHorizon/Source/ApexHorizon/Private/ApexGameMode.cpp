// Apex Horizon — game mode, player controller and HUD.

#include "ApexGameMode.h"

#include "ApexAIDriver.h"
#include "ApexHorizon.h"
#include "ApexMaterialLibrary.h"
#include "ApexMath.h"
#include "ApexTrackSpline.h"
#include "ApexVehiclePawn.h"
#include "ApexWorldActor.h"

#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/SpringArmComponent.h"
#include "Kismet/GameplayStatics.h"

using namespace ApexMath;

/* ═══════════════════════════ game mode ═══════════════════════════ */

AApexGameMode::AApexGameMode()
{
	PrimaryActorTick.bCanEverTick = true;
	// Vehicles are spawned and possessed explicitly once the world exists, so the
	// default restart path is suppressed rather than pointed at a pawn class.
	DefaultPawnClass = nullptr;
	bStartPlayersAsSpectators = true;
	PlayerControllerClass = AApexPlayerController::StaticClass();
	HUDClass = AApexHUD::StaticClass();
}

void AApexGameMode::BeginPlay()
{
	Super::BeginPlay();

	Materials = NewObject<UApexMaterialLibrary>(this, TEXT("MaterialLibrary"));
	Materials->Initialise();

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	WorldActor = GetWorld()->SpawnActor<AApexWorldActor>(AApexWorldActor::StaticClass(),
		FTransform::Identity, Params);
	WorldActor->BuildWorld(Materials, PropDensity);

	Weather = GetWorld()->SpawnActor<AApexWeather>(AApexWeather::StaticClass(), FTransform::Identity, Params);
	Weather->Configure(WorldActor, WeatherPreset, TimeOfDay, bAdvanceTimeDuringRace);

	RaceDirector = GetWorld()->SpawnActor<AApexRaceDirector>(AApexRaceDirector::StaticClass(),
		FTransform::Identity, Params);

	BuildField();
	RaceDirector->StartRace();
}

AApexVehiclePawn* AApexGameMode::SpawnVehicle(const FApexBuild& Build, const FTransform& At, bool bIsPlayer)
{
	const FApexCar* Car = FApexCatalogue::FindCar(Build.CarId);
	if (!Car)
	{
		Car = &FApexCatalogue::CarAt(0);
	}
	const FApexSpec Spec = FApexCatalogue::ResolveSpec(*Car, Build);

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	// Deferred so the drivetrain and body exist before the components register — the
	// Chaos vehicle is created from that configuration at physics-state creation.
	AApexVehiclePawn* Pawn = GetWorld()->SpawnActorDeferred<AApexVehiclePawn>(
		AApexVehiclePawn::StaticClass(), At, nullptr, nullptr,
		ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
	if (!Pawn)
	{
		return nullptr;
	}

	Pawn->bIsPlayer = bIsPlayer;
	Pawn->Configure(Spec, Materials, WorldActor);
	UGameplayStatics::FinishSpawningActor(Pawn, At);
	return Pawn;
}

void AApexGameMode::BuildField()
{
	const int32 FieldSize = (Mode == EApexRaceMode::Race) ? FMath::Clamp(RivalCount, 0, 11) + 1 : 1;
	const TArray<FApexPlacement> Slots = WorldActor->GridSlots(FieldSize);

	AllVehicles.Reset();
	AiDrivers.Reset();

	TArray<FApexEntrant> Entries;
	FRng Rng(0x51ee);

	for (int32 i = 0; i < FieldSize; ++i)
	{
		const bool bIsPlayer = (i == 0);
		const FTransform At(Slots[i].Rotation, Slots[i].Location);

		FApexBuild Build;
		if (bIsPlayer)
		{
			Build.CarId = PlayerCarId;
			Build.TyreId = PlayerTyreId;
			Build.Paint = FLinearColor(0.05f, 0.55f, 0.92f);
			Build.Finish = 1;
		}
		else
		{
			// rivals draw from the whole catalogue so the field has real variety
			const TArray<FApexCar>& Cars = FApexCatalogue::Cars();
			Build.CarId = Cars[Rng.RangeInt(0, Cars.Num())].Id;
			Build.TyreId = "sport";
			const TArray<FLinearColor>& Paints = FApexCatalogue::PaintPresets();
			Build.Paint = Paints[Rng.RangeInt(0, Paints.Num())];
			Build.Finish = Rng.RangeInt(0, 3);
		}

		AApexVehiclePawn* Pawn = SpawnVehicle(Build, At, bIsPlayer);
		if (!Pawn)
		{
			continue;
		}
		Pawn->DriverName = bIsPlayer ? TEXT("You") : FApexCatalogue::AiName(i - 1);
		AllVehicles.Add(Pawn);

		FApexEntrant Entry;
		Entry.Pawn = Pawn;
		Entry.bIsPlayer = bIsPlayer;
		Entry.Name = Pawn->DriverName;
		Entry.Colour = Build.Paint;

		if (bIsPlayer)
		{
			PlayerVehicle = Pawn;
			// The controller normally exists by now; if login is still in flight, Tick
			// picks it up on the next frame instead.
			if (APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0))
			{
				PC->Possess(Pawn);
				PC->SetViewTarget(Pawn);
			}
		}
		else
		{
			UApexAIDriver* Ai = NewObject<UApexAIDriver>(this);
			// a spread of pace so the field isn't a train
			const double Skill = 0.90 + Rng() * 0.16;
			const double Aggression = 0.35 + Rng() * 0.5;
			Ai->Initialise(Pawn, WorldActor, Skill, Aggression, i * 37 + 5);
			AiDrivers.Add(Ai);
			Entry.Ai = Ai;
		}

		Entries.Add(Entry);
	}

	RaceDirector->Setup(WorldActor, Materials, Entries, Laps, Mode);
	UE_LOG(LogApex, Log, TEXT("Field of %d cars on the grid — %d lap %s"),
		Entries.Num(), Laps, Mode == EApexRaceMode::Race ? TEXT("race") : TEXT("session"));
}

void AApexGameMode::RestartEvent()
{
	for (AApexVehiclePawn* Pawn : AllVehicles)
	{
		if (Pawn)
		{
			Pawn->Destroy();
		}
	}
	AllVehicles.Reset();
	AiDrivers.Reset();
	PlayerVehicle = nullptr;

	RaceDirector->Reset();
	BuildField();
	RaceDirector->StartRace();
}

void AApexGameMode::HandleRaceEvents()
{
	auto SetBanner = [this](const FString& Text, float Seconds)
	{
		BannerText = Text;
		BannerTimer = Seconds;
	};

	for (const FApexRaceEvent& Event : RaceDirector->ConsumeEvents())
	{
		switch (Event.Type)
		{
		case EApexRaceEventType::Countdown:
			SetBanner(FString::FromInt(Event.Value), 0.9f);
			break;
		case EApexRaceEventType::Go:
			SetBanner(TEXT("GO"), 1.4f);
			break;
		case EApexRaceEventType::BestLap:
			SetBanner(FString::Printf(TEXT("BEST LAP  %s"), *FormatTime(Event.Time)), 2.6f);
			break;
		case EApexRaceEventType::Lap:
			UE_LOG(LogApex, Log, TEXT("%s completed lap %d in %s"),
				*Event.Name, Event.Value, *FormatTime(Event.Time));
			break;
		case EApexRaceEventType::Finish:
			UE_LOG(LogApex, Log, TEXT("%s finished P%d at %s"),
				*Event.Name, Event.Value, *FormatTime(Event.Time));
			if (Event.Name == TEXT("You"))
			{
				SetBanner(FString::Printf(TEXT("FINISHED  P%d"), Event.Value), 5.f);
			}
			break;
		case EApexRaceEventType::RaceOver:
			SetBanner(TEXT("RACE OVER"), 6.f);
			UE_LOG(LogApex, Log, TEXT("Race over at %s"), *FormatTime(Event.Time));
			break;
		default:
			break;
		}
	}
}

void AApexGameMode::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	if (!RaceDirector || !WorldActor || !WorldActor->IsBuilt())
	{
		return;
	}

	if (PlayerVehicle && PlayerVehicle->GetController() == nullptr)
	{
		if (APlayerController* PC = UGameplayStatics::GetPlayerController(this, 0))
		{
			PC->Possess(PlayerVehicle);
			PC->SetViewTarget(PlayerVehicle);
		}
	}

	const bool bAllowDrive = RaceDirector->AllowDrive();
	for (UApexAIDriver* Ai : AiDrivers)
	{
		if (Ai)
		{
			Ai->Update(DeltaSeconds, ObjectPtrDecay(AllVehicles), bAllowDrive);
		}
	}

	// hold the player on the brakes until the lights go out
	if (!bAllowDrive && PlayerVehicle)
	{
		PlayerVehicle->SetControls(0.f, 1.f, 0.f, 1.f);
	}

	// headlights follow the sun
	if (Weather)
	{
		const bool bNight = Weather->IsNight();
		for (AApexVehiclePawn* Pawn : AllVehicles)
		{
			if (Pawn && !Pawn->bIsPlayer && Pawn->AreHeadlightsOn() != bNight)
			{
				Pawn->SetHeadlights(bNight);
			}
		}
	}

	HandleRaceEvents();
	BannerTimer = FMath::Max(0.f, BannerTimer - DeltaSeconds);
}

/* ═══════════════════════════ player controller ═══════════════════════════ */

AApexPlayerController::AApexPlayerController()
{
	bShowMouseCursor = false;
	PrimaryActorTick.bCanEverTick = true;
}

void AApexPlayerController::BeginPlay()
{
	Super::BeginPlay();
	SetInputMode(FInputModeGameOnly());
}

void AApexPlayerController::PollDriving(float DeltaSeconds)
{
	AApexVehiclePawn* Vehicle = Cast<AApexVehiclePawn>(GetPawn());
	if (!Vehicle)
	{
		return;
	}

	AApexGameMode* GameMode = Cast<AApexGameMode>(UGameplayStatics::GetGameMode(this));
	if (GameMode && GameMode->GetRaceDirector() && !GameMode->GetRaceDirector()->AllowDrive())
	{
		return;   // the game mode holds the car on the grid
	}

	// Keyboard is digital, so throttle and steering are ramped; the pad is read directly
	// and wins whenever it is being used.
	const bool bThrottleKey = IsInputKeyDown(EKeys::W) || IsInputKeyDown(EKeys::Up);
	const bool bBrakeKey = IsInputKeyDown(EKeys::S) || IsInputKeyDown(EKeys::Down);
	const bool bLeftKey = IsInputKeyDown(EKeys::A) || IsInputKeyDown(EKeys::Left);
	const bool bRightKey = IsInputKeyDown(EKeys::D) || IsInputKeyDown(EKeys::Right);
	const bool bHandbrake = IsInputKeyDown(EKeys::SpaceBar) || IsInputKeyDown(EKeys::Gamepad_FaceButton_Bottom);

	float Throttle = bThrottleKey ? 1.f : 0.f;
	float Brake = bBrakeKey ? 1.f : 0.f;

	const float PadThrottle = GetInputAnalogKeyState(EKeys::Gamepad_RightTriggerAxis);
	const float PadBrake = GetInputAnalogKeyState(EKeys::Gamepad_LeftTriggerAxis);
	Throttle = FMath::Max(Throttle, PadThrottle);
	Brake = FMath::Max(Brake, PadBrake);

	const float PadSteer = GetInputAnalogKeyState(EKeys::Gamepad_LeftX);
	float TargetSteer = 0.f;
	if (bLeftKey) { TargetSteer -= 1.f; }
	if (bRightKey) { TargetSteer += 1.f; }

	// Ease keyboard steering at speed so the car stays driveable on a hard input.
	const float Speed = FMath::Abs(Vehicle->GetSpeed());
	const float Rate = FMath::Lerp(7.f, 2.6f, FMath::Clamp(Speed / 60.f, 0.f, 1.f));
	SteerAxis = static_cast<float>(Damp(SteerAxis, TargetSteer, Rate, DeltaSeconds));
	if (FMath::Abs(TargetSteer) < KINDA_SMALL_NUMBER && FMath::Abs(SteerAxis) < 0.01f)
	{
		SteerAxis = 0.f;
	}

	const float Steer = FMath::Abs(PadSteer) > 0.08f ? PadSteer : SteerAxis;
	Vehicle->SetControls(Throttle, Brake, Steer, bHandbrake ? 1.f : 0.f);
}

void AApexPlayerController::PollActions()
{
	AApexVehiclePawn* Vehicle = Cast<AApexVehiclePawn>(GetPawn());
	if (!Vehicle)
	{
		return;
	}

	if (WasInputKeyJustPressed(EKeys::C) || WasInputKeyJustPressed(EKeys::Gamepad_FaceButton_Top))
	{
		Vehicle->CycleCamera();
	}
	if (WasInputKeyJustPressed(EKeys::R) || WasInputKeyJustPressed(EKeys::Gamepad_FaceButton_Left))
	{
		Vehicle->ResetToTrack();
	}
	if (WasInputKeyJustPressed(EKeys::L))
	{
		Vehicle->SetHeadlights(!Vehicle->AreHeadlightsOn());
	}
	if (WasInputKeyJustPressed(EKeys::M))
	{
		Vehicle->SetManualGearbox(!Vehicle->IsManualGearbox());
	}

	Vehicle->SetLookBack(IsInputKeyDown(EKeys::B) || IsInputKeyDown(EKeys::Gamepad_RightThumbstick));

	const bool bUp = IsInputKeyDown(EKeys::E) || IsInputKeyDown(EKeys::Gamepad_RightShoulder);
	const bool bDown = IsInputKeyDown(EKeys::Q) || IsInputKeyDown(EKeys::Gamepad_LeftShoulder);
	if (bUp && !bPrevShiftUp) { Vehicle->ShiftUp(); }
	if (bDown && !bPrevShiftDown) { Vehicle->ShiftDown(); }
	bPrevShiftUp = bUp;
	bPrevShiftDown = bDown;

	if (WasInputKeyJustPressed(EKeys::Enter))
	{
		if (AApexGameMode* GameMode = Cast<AApexGameMode>(UGameplayStatics::GetGameMode(this)))
		{
			GameMode->RestartEvent();
		}
	}
}

void AApexPlayerController::PlayerTick(float DeltaSeconds)
{
	Super::PlayerTick(DeltaSeconds);
	PollDriving(DeltaSeconds);
	PollActions();
}
