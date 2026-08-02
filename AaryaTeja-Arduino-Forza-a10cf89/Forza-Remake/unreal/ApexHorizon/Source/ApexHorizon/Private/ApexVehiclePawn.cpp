// Apex Horizon — the vehicle.

#include "ApexVehiclePawn.h"

#include "ApexCarBody.h"
#include "ApexHorizon.h"
#include "ApexMaterialLibrary.h"
#include "ApexMath.h"
#include "ApexMeshBuilder.h"
#include "ApexWorldActor.h"

#include "Camera/CameraComponent.h"
#include "Components/SpotLightComponent.h"
#include "GameFramework/SpringArmComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "ProceduralMeshComponent.h"

using namespace ApexMath;

/* ═══════════════════════════ wheels ═══════════════════════════ */

void UApexWheelBase::InitFromCar(FName CarId, bool bFront)
{
	const FApexCar* Car = FApexCatalogue::FindCar(CarId);
	if (!Car)
	{
		return;
	}
	const FApexBodySpec& B = Car->Body;
	const FApexSuspensionSpec& S = Car->Suspension;

	AxleType = bFront ? EAxleType::Front : EAxleType::Rear;
	bAffectedBySteering = bFront;
	bAffectedByHandbrake = !bFront;
	bAffectedByBrake = true;
	bABSEnabled = true;
	bTractionControlEnabled = true;

	WheelRadius = static_cast<float>(B.WheelRadius * APEX_TO_UE);
	WheelWidth = static_cast<float>(B.WheelWidth * APEX_TO_UE);
	WheelMass = static_cast<float>(Car->Mass * 0.016);
	MaxSteerAngle = bFront ? static_cast<float>(FMath::RadiansToDegrees(Car->SteerLock)) : 0.f;

	// The source stiffness is an acceleration-per-metre, so the per-wheel rate is
	// stiffness × mass / 4; the extra divisor converts that into Chaos' spring units,
	// calibrated so the hot hatch lands on Chaos' own default of 250.
	SpringRate = static_cast<float>(S.Stiffness * Car->Mass / 160.0);
	SpringPreload = static_cast<float>(Car->Mass * 9.81 / 4.0 / 100.0);
	SuspensionDampingRatio = static_cast<float>(
		0.5 * (S.Compression + S.Relaxation) / (2.0 * FMath::Sqrt(static_cast<double>(S.Stiffness))));

	const float Travel = static_cast<float>(S.Travel * APEX_TO_UE);
	SuspensionMaxRaise = Travel * 0.45f;
	SuspensionMaxDrop = Travel * 0.55f;

	RollbarScaling = 0.15f;
	// Chaos' tyre model is tuned around a multiplier of 2 for a sport compound; the
	// per-build tyre and upgrade contributions are applied per instance at runtime.
	FrictionForceMultiplier = static_cast<float>(2.0 * Car->TyreGripBase);
}

TSubclassOf<UChaosVehicleWheel> ApexWheelClassFor(FName CarId, bool bFront)
{
	if (CarId == "aurelia") { return bFront ? UApexWheelAureliaFront::StaticClass() : static_cast<UClass*>(UApexWheelAureliaRear::StaticClass()); }
	if (CarId == "baron") { return bFront ? UApexWheelBaronFront::StaticClass() : static_cast<UClass*>(UApexWheelBaronRear::StaticClass()); }
	if (CarId == "vulcan") { return bFront ? UApexWheelVulcanFront::StaticClass() : static_cast<UClass*>(UApexWheelVulcanRear::StaticClass()); }
	if (CarId == "mistral") { return bFront ? UApexWheelMistralFront::StaticClass() : static_cast<UClass*>(UApexWheelMistralRear::StaticClass()); }
	return bFront ? UApexWheelKestrelFront::StaticClass() : static_cast<UClass*>(UApexWheelKestrelRear::StaticClass());
}

bool UApexVehicleMovementComponent::CanCreateVehicle() const
{
	// Deliberately skips UChaosWheeledVehicleMovementComponent::CanCreateVehicle, whose
	// only extra requirement over this is that every wheel names a skeleton bone.
	if (!UChaosVehicleMovementComponent::CanCreateVehicle())
	{
		return false;
	}

	for (int32 WheelIdx = 0; WheelIdx < WheelSetups.Num(); ++WheelIdx)
	{
		if (WheelSetups[WheelIdx].WheelClass == nullptr)
		{
			UE_LOG(LogApex, Warning, TEXT("Wheel %d has no class set on %s"), WheelIdx, *GetPathName());
			return false;
		}
	}
	return true;
}

/* ═══════════════════════════ pawn ═══════════════════════════ */

AApexVehiclePawn::AApexVehiclePawn()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickGroup = TG_PostPhysics;

	Chassis = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("Chassis"));
	Chassis->SetMobility(EComponentMobility::Movable);
	Chassis->bUseComplexAsSimpleCollision = false;
	Chassis->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
	Chassis->SetCollisionObjectType(ECC_Pawn);
	Chassis->SetCollisionResponseToAllChannels(ECR_Block);
	Chassis->SetNotifyRigidBodyCollision(true);
	Chassis->SetGenerateOverlapEvents(false);
	Chassis->SetCastShadow(true);
	RootComponent = Chassis;

	Movement = CreateDefaultSubobject<UApexVehicleMovementComponent>(TEXT("VehicleMovement"));
	Movement->SetIsReplicated(true);
	Movement->UpdatedComponent = Chassis;

	SpringArm = CreateDefaultSubobject<USpringArmComponent>(TEXT("SpringArm"));
	SpringArm->SetupAttachment(Chassis);
	SpringArm->TargetArmLength = 620.f;
	SpringArm->SocketOffset = FVector(0.f, 0.f, 180.f);
	SpringArm->bDoCollisionTest = true;
	SpringArm->bEnableCameraLag = true;
	SpringArm->bEnableCameraRotationLag = true;
	SpringArm->CameraLagSpeed = 11.f;
	SpringArm->CameraRotationLagSpeed = 9.f;
	SpringArm->bInheritPitch = false;
	SpringArm->bInheritRoll = false;
	SpringArm->SetRelativeRotation(FRotator(-9.f, 0.f, 0.f));

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(SpringArm, USpringArmComponent::SocketName);
	Camera->FieldOfView = 88.f;

	// Components register during spawn, before Configure() picks a car, so Chaos builds
	// a vehicle from this configuration first and complains if the torque curve is
	// empty. Seeding the shared curve here keeps that first pass quiet; BeginPlay
	// rebuilds the vehicle once the real drivetrain is in place.
	if (FRichCurve* Curve = Movement->EngineSetup.TorqueCurve.GetRichCurve())
	{
		for (int32 i = 0; i <= 10; ++i)
		{
			const double Frac = static_cast<double>(i) / 10.0;
			Curve->AddKey(static_cast<float>(Frac * 7000.0), static_cast<float>(ApexTorqueFactor(Frac)));
		}
	}
}

void AApexVehiclePawn::Configure(const FApexSpec& InSpec, UApexMaterialLibrary* InMaterials, AApexWorldActor* InWorld)
{
	Spec = InSpec;
	Materials = InMaterials;
	World = InWorld;
	LiveryColour = InSpec.Build.Paint;

	BuildBodyMesh();
	BuildWheelMeshes();
	ConfigureDrivetrain();

	bConfigured = true;
}

void AApexVehiclePawn::BuildBodyMesh()
{
	FApexMeshGroup Body;
	ApexCarBody::Build(Spec.Car, Body);

	PaintMid = Materials ? Materials->CreateCarPaint(Spec.Build.Paint, Spec.Build.Finish, Spec.Build.bStripes) : nullptr;
	HeadMid = Materials ? Materials->CreateEmissive(FLinearColor(1.f, 0.96f, 0.88f), 0.f) : nullptr;
	TailMid = Materials ? Materials->CreateEmissive(FLinearColor(1.f, 0.08f, 0.05f), 2.f) : nullptr;

	for (int32 i = 0; i < Body.NumSections(); ++i)
	{
		Body.SectionAt(i).ToSection(Chassis, i, /*bCreateCollision*/ false);

		const FName Key = Body.SectionMaterials[i];
		UMaterialInterface* M = nullptr;
		if (Key == "carPaint") { M = PaintMid; }
		else if (Key == "headlight") { M = HeadMid; }
		else if (Key == "taillight") { M = TailMid; }
		else if (Materials) { M = Materials->Get(Key); }

		if (M)
		{
			Chassis->SetMaterial(i, M);
		}
	}

	// Simple collision: one convex box around the body, so the chassis can simulate.
	FVector Centre, HalfExtents;
	ApexCarBody::GetCollisionExtents(Spec.Car, Centre, HalfExtents);

	TArray<FVector> Hull;
	for (int32 Sx = -1; Sx <= 1; Sx += 2)
	{
		for (int32 Sy = -1; Sy <= 1; Sy += 2)
		{
			for (int32 Sz = -1; Sz <= 1; Sz += 2)
			{
				Hull.Add(Centre + FVector(Sx * HalfExtents.X, Sy * HalfExtents.Y, Sz * HalfExtents.Z));
			}
		}
	}
	Chassis->ClearCollisionConvexMeshes();
	Chassis->AddCollisionConvexMesh(Hull);

	Chassis->SetSimulatePhysics(true);
	Chassis->SetEnableGravity(true);
	Chassis->BodyInstance.bNotifyRigidBodyCollision = true;
	Chassis->BodyInstance.SetUseCCD(true);
	Chassis->SetMassOverrideInKg(NAME_None, Spec.Mass, true);

	// headlights
	{
		const double NoseX = Spec.Car.Body.Length * 0.5 * APEX_TO_UE - 10.0;
		const double LampY = Spec.Car.Body.Width * 0.30 * APEX_TO_UE;
		const double LampZ = (Spec.Car.Body.RideHeight + 0.52) * APEX_TO_UE;
		for (double Side : { -1.0, 1.0 })
		{
			USpotLightComponent* Light = NewObject<USpotLightComponent>(this,
				*FString::Printf(TEXT("Headlight_%s"), Side < 0 ? TEXT("L") : TEXT("R")));
			Light->SetupAttachment(Chassis);
			Light->SetRelativeLocation(FVector(NoseX, Side * LampY, LampZ));
			Light->SetRelativeRotation(FRotator(-4.f, 0.f, 0.f));
			Light->SetIntensityUnits(ELightUnits::Lumens);
			Light->SetIntensity(22000.f);
			Light->SetAttenuationRadius(9000.f);
			Light->SetInnerConeAngle(14.f);
			Light->SetOuterConeAngle(42.f);
			Light->SetLightColor(FLinearColor(1.f, 0.96f, 0.90f));
			Light->SetCastShadows(false);
			Light->SetVisibility(false);
			Headlights.Add(Light);
		}
	}
}

void AApexVehiclePawn::BuildWheelMeshes()
{
	const FApexBodySpec& B = Spec.Car.Body;

	FApexMeshGroup WheelGeo;
	ApexCarBody::BuildWheel(B.WheelRadius, B.WheelWidth, /*RimStyle*/ 1, WheelGeo);

	BrakeMid = Materials ? Materials->CreateEmissive(FLinearColor(1.f, 0.22f, 0.05f), 0.f) : nullptr;

	static const TCHAR* Names[4] = { TEXT("WheelFL"), TEXT("WheelFR"), TEXT("WheelRL"), TEXT("WheelRR") };

	for (int32 i = 0; i < 4; ++i)
	{
		UProceduralMeshComponent* Wheel = NewObject<UProceduralMeshComponent>(this, Names[i]);
		Wheel->SetupAttachment(Chassis);
		Wheel->SetMobility(EComponentMobility::Movable);
		Wheel->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Wheel->SetCastShadow(true);

		for (int32 S = 0; S < WheelGeo.NumSections(); ++S)
		{
			WheelGeo.SectionAt(S).ToSection(Wheel, S, false);
			const FName Key = WheelGeo.SectionMaterials[S];
			UMaterialInterface* M = (Key == "brakeDisc") ? Cast<UMaterialInterface>(BrakeMid)
				: (Materials ? Materials->Get(Key) : nullptr);
			if (M)
			{
				Wheel->SetMaterial(S, M);
			}
		}

		// mirror the right-hand wheels so the rim face points outward
		const bool bRight = (i == 1 || i == 3);
		Wheel->SetRelativeScale3D(FVector(1.f, bRight ? -1.f : 1.f, 1.f));

		WheelMeshes.Add(Wheel);
	}
}

void AApexVehiclePawn::ConfigureDrivetrain()
{
	const FApexCar& Car = Spec.Car;
	const FApexBodySpec& B = Car.Body;

	Movement->Mass = Spec.Mass;
	Movement->ChassisWidth = B.Width * APEX_TO_UE;
	Movement->ChassisHeight = (B.RideHeight + 0.6) * APEX_TO_UE;
	Movement->bEnableCenterOfMassOverride = true;
	Movement->CenterOfMassOverride = FVector(
		0.f, 0.f, static_cast<float>((0.55 + B.RideHeight + Car.ComHeight) * APEX_TO_UE));

	// Drag/downforce are expressed as CdA in the source data, so the reference area is
	// pinned to 1 m² and the coefficient carries the whole product.
	Movement->DragArea = 10000.f;                       // cm² = 1 m²
	Movement->DragCoefficient = Spec.CdA;
	Movement->DownforceCoefficient = Spec.DownforceCoef;

	Movement->bMechanicalSimEnabled = true;
	Movement->bReverseAsBrake = true;

	/* ── engine ── */
	FVehicleEngineConfig& Engine = Movement->EngineSetup;
	Engine.MaxTorque = Spec.PeakTorque;
	Engine.MaxRPM = Car.Engine.Redline;
	Engine.EngineIdleRPM = Car.Engine.Idle;
	Engine.EngineBrakeEffect = 0.06f;
	Engine.EngineRevUpMOI = FMath::Max(1.f, Car.Engine.RevInertia * 20.f);
	Engine.EngineRevDownRate = 600.f;

	if (FRichCurve* Curve = Engine.TorqueCurve.GetRichCurve())
	{
		Curve->Reset();
		for (int32 i = 0; i <= 20; ++i)
		{
			const double Frac = static_cast<double>(i) / 20.0;
			Curve->AddKey(static_cast<float>(Frac * Car.Engine.Redline),
				static_cast<float>(ApexTorqueFactor(Frac)));
		}
	}

	/* ── transmission ── */
	FVehicleTransmissionConfig& Trans = Movement->TransmissionSetup;
	Trans.bUseAutomaticGears = true;
	Trans.bUseAutoReverse = true;
	Trans.FinalRatio = Spec.FinalDrive;
	Trans.ForwardGearRatios = Car.Gears;
	Trans.ReverseGearRatios = { Car.ReverseGear };
	Trans.ChangeUpRPM = Car.Engine.Redline * 0.93f;
	Trans.ChangeDownRPM = Car.Engine.Redline * 0.46f;
	Trans.GearChangeTime = Spec.ShiftTime;
	Trans.TransmissionEfficiency = Car.DriveEfficiency;

	/* ── differential ── */
	FVehicleDifferentialConfig& Diff = Movement->DifferentialSetup;
	switch (Car.Drivetrain)
	{
	case EApexDrivetrain::FWD:
		Diff.DifferentialType = EVehicleDifferential::FrontWheelDrive;
		Diff.FrontRearSplit = 1.f;
		break;
	case EApexDrivetrain::RWD:
		Diff.DifferentialType = EVehicleDifferential::RearWheelDrive;
		Diff.FrontRearSplit = 0.f;
		break;
	default:
		Diff.DifferentialType = EVehicleDifferential::AllWheelDrive;
		Diff.FrontRearSplit = 0.6f;   // rear-biased, as the source cars are
		break;
	}

	/* ── steering ── */
	FVehicleSteeringConfig& Steer = Movement->SteeringSetup;
	Steer.SteeringType = ESteeringType::Ackermann;
	if (FRichCurve* Curve = Steer.SteeringCurve.GetRichCurve())
	{
		// speed-sensitive steering: full lock at a standstill, ~38 % at 160 mph
		Curve->Reset();
		Curve->AddKey(0.f, 1.0f);
		Curve->AddKey(30.f, 0.86f);
		Curve->AddKey(70.f, 0.60f);
		Curve->AddKey(120.f, 0.45f);
		Curve->AddKey(180.f, 0.38f);
	}

	/* ── wheel placement ── */
	const double HalfBase = B.Wheelbase * 0.5 * APEX_TO_UE;
	const double HalfTrackF = B.TrackF * 0.5 * APEX_TO_UE;
	const double HalfTrackR = B.TrackR * 0.5 * APEX_TO_UE;
	const double HubZ = B.WheelRadius * APEX_TO_UE;

	const FVector Offsets[4] = {
		FVector(HalfBase, -HalfTrackF, HubZ),   // front left
		FVector(HalfBase,  HalfTrackF, HubZ),   // front right
		FVector(-HalfBase, -HalfTrackR, HubZ),  // rear left
		FVector(-HalfBase,  HalfTrackR, HubZ),  // rear right
	};

	Movement->WheelSetups.SetNum(4);
	for (int32 i = 0; i < 4; ++i)
	{
		Movement->WheelSetups[i].WheelClass = ApexWheelClassFor(Car.Id, /*bFront*/ i < 2);
		Movement->WheelSetups[i].BoneName = NAME_None;
		Movement->WheelSetups[i].AdditionalOffset = Offsets[i];
	}
}

void AApexVehiclePawn::ApplyRuntimeTuning()
{
	if (!Movement || Movement->Wheels.Num() < 4)
	{
		return;   // the vehicle is not up yet; Tick retries until it is
	}

	const FApexCar& Car = Spec.Car;
	const FApexBodySpec& B = Car.Body;

	// Total braking force from the source data's "brakeStrength × 3 g" convention.
	const double TotalBrakeTorque = Spec.Mass * 9.81 * Spec.BrakeStrength * 3.0 * B.WheelRadius;
	const double FrontBrake = TotalBrakeTorque * Spec.BrakeBias * 0.5;
	const double RearBrake = TotalBrakeTorque * (1.0 - Spec.BrakeBias) * 0.5;

	const double SteerDegrees = FMath::RadiansToDegrees(Spec.SteerLock);
	// 1.28 is the "sport" compound, the baseline the wheel classes are calibrated around.
	const double FrictionMultiplier = 2.0 * Spec.Grip / 1.28;

	// Wheel geometry and suspension rates come from the per-car wheel class; only the
	// values that depend on the player's build are patched per instance here.
	for (int32 i = 0; i < 4; ++i)
	{
		const bool bFront = i < 2;

		Movement->SetWheelFrictionMultiplier(i, FrictionMultiplier);
		Movement->SetWheelMaxBrakeTorque(i, bFront ? FrontBrake : RearBrake);
		Movement->SetWheelHandbrakeTorque(i, bFront ? 0.0 : RearBrake * 2.2);
		Movement->SetWheelMaxSteerAngle(i, bFront ? SteerDegrees : 0.0);
		Movement->SetABSEnabled(i, true);
		Movement->SetTractionControlEnabled(i, true);

		// anti-roll: the tune sliders scale each axle's rollbar contribution
		if (UChaosVehicleWheel* Wheel = Movement->Wheels[i])
		{
			Wheel->RollbarScaling = static_cast<float>(0.05 + (bFront ? Spec.ArbFront : Spec.ArbRear) * 0.45);
		}
	}

	bTuningApplied = true;
}

void AApexVehiclePawn::BeginPlay()
{
	Super::BeginPlay();

	// The pawn's components register during SpawnActorDeferred — before Configure() has
	// filled in the wheel setups and torque curve — so Chaos first builds the vehicle
	// from an empty configuration and switches the mechanical simulation off. Rebuilding
	// the physics state here re-runs SetupVehicle against the real drivetrain.
	Movement->bMechanicalSimEnabled = true;
	Movement->RecreatePhysicsState();

	ApplyRuntimeTuning();
	ApplyCameraMode();
}

void AApexVehiclePawn::SetControls(float Throttle, float Brake, float Steer, float Handbrake)
{
	InputThrottle = FMath::Clamp(Throttle, 0.f, 1.f);
	InputBrake = FMath::Clamp(Brake, 0.f, 1.f);
	InputSteer = FMath::Clamp(Steer, -1.f, 1.f);
	InputHandbrake = FMath::Clamp(Handbrake, 0.f, 1.f);

	if (Movement)
	{
		Movement->SetThrottleInput(InputThrottle);
		Movement->SetBrakeInput(InputBrake);
		Movement->SetSteeringInput(InputSteer);
		Movement->SetHandbrakeInput(InputHandbrake > 0.5f);
	}
}

void AApexVehiclePawn::ShiftUp()
{
	if (Movement)
	{
		Movement->SetChangeUpInput(true);
	}
}

void AApexVehiclePawn::ShiftDown()
{
	if (Movement)
	{
		Movement->SetChangeDownInput(true);
	}
}

void AApexVehiclePawn::SetManualGearbox(bool bManual)
{
	if (Movement)
	{
		Movement->TransmissionSetup.bUseAutomaticGears = !bManual;
	}
}

bool AApexVehiclePawn::IsManualGearbox() const
{
	return Movement && !Movement->TransmissionSetup.bUseAutomaticGears;
}

void AApexVehiclePawn::PlaceAt(const FVector& Location, const FRotator& Rotation)
{
	if (Chassis)
	{
		Chassis->SetPhysicsLinearVelocity(FVector::ZeroVector);
		Chassis->SetPhysicsAngularVelocityInRadians(FVector::ZeroVector);
	}
	SetActorLocationAndRotation(Location, Rotation, false, nullptr, ETeleportType::TeleportPhysics);
	SetControls(0.f, 0.f, 0.f, 0.f);
}

void AApexVehiclePawn::ResetToTrack()
{
	if (!World)
	{
		return;
	}
	const FApexPlacement Spot = World->RespawnPoint(GetActorLocation(), 6.0);
	PlaceAt(Spot.Location, Spot.Rotation);
}

void AApexVehiclePawn::SetHeadlights(bool bOn)
{
	bHeadlights = bOn;
	for (USpotLightComponent* Light : Headlights)
	{
		if (Light)
		{
			Light->SetVisibility(bOn);
		}
	}
	if (HeadMid)
	{
		HeadMid->SetScalarParameterValue("EmissiveStrength", bOn ? 28.f : 0.f);
	}
}

void AApexVehiclePawn::CycleCamera()
{
	CameraMode = (CameraMode + 1) % 4;
	ApplyCameraMode();
}

void AApexVehiclePawn::SetLookBack(bool bInLookBack)
{
	if (bLookBack != bInLookBack)
	{
		bLookBack = bInLookBack;
		ApplyCameraMode();
	}
}

void AApexVehiclePawn::ApplyCameraMode()
{
	if (!SpringArm || !Camera)
	{
		return;
	}

	const FApexBodySpec& B = Spec.Car.Body;
	const double Len = B.Length * APEX_TO_UE;
	const double Ride = B.RideHeight * APEX_TO_UE;

	switch (CameraMode)
	{
	case 0: // chase
		SpringArm->TargetArmLength = 620.f;
		SpringArm->SetRelativeLocation(FVector(0.f, 0.f, Ride + 60.f));
		SpringArm->SocketOffset = FVector(0.f, 0.f, 180.f);
		SpringArm->bEnableCameraLag = true;
		SpringArm->bEnableCameraRotationLag = true;
		Camera->FieldOfView = 88.f;
		break;

	case 1: // hood
		SpringArm->TargetArmLength = 0.f;
		SpringArm->SetRelativeLocation(FVector(Len * 0.08, 0.f, Ride + 105.f));
		SpringArm->SocketOffset = FVector::ZeroVector;
		SpringArm->bEnableCameraLag = false;
		SpringArm->bEnableCameraRotationLag = false;
		Camera->FieldOfView = 82.f;
		break;

	case 2: // bumper
		SpringArm->TargetArmLength = 0.f;
		SpringArm->SetRelativeLocation(FVector(Len * 0.42, 0.f, Ride + 42.f));
		SpringArm->SocketOffset = FVector::ZeroVector;
		SpringArm->bEnableCameraLag = false;
		SpringArm->bEnableCameraRotationLag = false;
		Camera->FieldOfView = 94.f;
		break;

	default: // cockpit
		SpringArm->TargetArmLength = 0.f;
		SpringArm->SetRelativeLocation(FVector(-Len * 0.04, -B.Width * 0.19 * APEX_TO_UE, Ride + 92.f));
		SpringArm->SocketOffset = FVector::ZeroVector;
		SpringArm->bEnableCameraLag = false;
		SpringArm->bEnableCameraRotationLag = false;
		Camera->FieldOfView = 78.f;
		break;
	}

	SpringArm->SetRelativeRotation(FRotator(CameraMode == 0 ? -9.f : -2.f, bLookBack ? 180.f : 0.f, 0.f));
}

void AApexVehiclePawn::UpdateWheelVisuals()
{
	if (!Movement || WheelMeshes.Num() < 4)
	{
		return;
	}

	for (int32 i = 0; i < 4 && i < Movement->Wheels.Num(); ++i)
	{
		UChaosVehicleWheel* Wheel = Movement->Wheels[i];
		UProceduralMeshComponent* Mesh = WheelMeshes[i];
		if (!Wheel || !Mesh)
		{
			continue;
		}

		const FVector Rest = Movement->WheelSetups[i].AdditionalOffset;
		// Suspension offset: the normalised length is 1 at full droop, 0 fully compressed.
		double Sink = 0.0;
		if (Movement->GetNumWheels() > i)
		{
			const FWheelStatus& Status = Movement->GetWheelState(i);
			if (Status.bIsValid)
			{
				Sink = (Status.NormalizedSuspensionLength - 0.5) * (Wheel->SuspensionMaxDrop + Wheel->SuspensionMaxRaise);
			}
		}

		// The wheel meshes are built with their axle along local Y, so the rolling
		// angle is pitch and the steering angle is yaw.
		Mesh->SetRelativeLocation(FVector(Rest.X, Rest.Y, Rest.Z - Sink));
		Mesh->SetRelativeRotation(FRotator(-Wheel->GetRotationAngle(), Wheel->GetSteerAngle(), 0.f));
	}
}

void AApexVehiclePawn::UpdateTelemetry(float DeltaSeconds)
{
	const FVector Forward = GetActorForwardVector();
	const FVector Velocity = GetVelocity();

	Telemetry.Speed = FVector::DotProduct(Velocity, Forward) / APEX_TO_UE;
	Telemetry.Throttle = InputThrottle;
	Telemetry.Brake = InputBrake;
	Telemetry.Steer = InputSteer;
	Telemetry.Upright = static_cast<float>(GetActorUpVector().Z);

	if (Movement)
	{
		Telemetry.Rpm = Movement->GetEngineRotationSpeed();
		Telemetry.Gear = Movement->GetCurrentGear();
	}

	if (Chassis)
	{
		Telemetry.YawRate = Chassis->GetPhysicsAngularVelocityInRadians().Z;
	}

	const FVector FlatVel = FVector(Velocity.X, Velocity.Y, 0.f);
	if (FlatVel.SizeSquared() > 100.f)
	{
		const FVector FlatFwd = FVector(Forward.X, Forward.Y, 0.f).GetSafeNormal();
		const double Dot = FMath::Clamp(FVector::DotProduct(FlatVel.GetSafeNormal(), FlatFwd), -1.0, 1.0);
		Telemetry.DriftAngle = static_cast<float>(FMath::Acos(Dot));
	}
	else
	{
		Telemetry.DriftAngle = 0.f;
	}

	int32 OnGround = 0;
	float WorstSlip = 0.f;
	if (Movement)
	{
		for (int32 i = 0; i < Movement->GetNumWheels(); ++i)
		{
			const FWheelStatus& Status = Movement->GetWheelState(i);
			if (Status.bInContact)
			{
				++OnGround;
			}
			WorstSlip = FMath::Max(WorstSlip, FMath::Abs(Status.SlipMagnitude));
		}
	}
	Telemetry.WheelsOnGround = OnGround;
	Telemetry.SlipAmount = FMath::Clamp(WorstSlip / 600.f, 0.f, 1.f);

	// brake discs glow with sustained braking and cool off again
	const float TargetGlow = InputBrake * FMath::Clamp(FMath::Abs(Telemetry.Speed) / 40.f, 0.f, 1.f);
	BrakeGlow = static_cast<float>(Damp(BrakeGlow, TargetGlow, TargetGlow > BrakeGlow ? 3.0 : 0.5, DeltaSeconds));
	if (BrakeMid)
	{
		BrakeMid->SetScalarParameterValue("EmissiveStrength", BrakeGlow * 14.f);
	}
	if (TailMid)
	{
		TailMid->SetScalarParameterValue("EmissiveStrength", 2.f + InputBrake * 16.f + (bHeadlights ? 3.f : 0.f));
	}
}

void AApexVehiclePawn::UpdateSurfaceGrip()
{
	if (!World || !Movement || Movement->Wheels.Num() < 4)
	{
		return;
	}

	const FApexSplineQuery Q = World->QuerySurfaceUE(GetActorLocation());
	Telemetry.bOnRoad = Q.bOnRoad;

	// Wet tarmac and running off the racing surface both cost real grip, exactly as
	// they do in the source simulation.
	double Surface = Q.bOnRoad
		? Lerp(1.0, Spec.WetGrip / FMath::Max(Spec.Grip, 0.01), World->Wetness)
		: Spec.OffroadGrip / FMath::Max(Spec.Grip, 0.01);
	Surface = FMath::Clamp(Surface, 0.25, 1.4);

	const double Multiplier = 2.0 * Spec.Grip / 1.28 * Surface;
	for (int32 i = 0; i < 4; ++i)
	{
		Movement->SetWheelFrictionMultiplier(i, Multiplier);
	}
}

void AApexVehiclePawn::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!bConfigured)
	{
		return;
	}

	if (!bTuningApplied)
	{
		ApplyRuntimeTuning();
	}

	UpdateTelemetry(DeltaSeconds);
	UpdateWheelVisuals();

	// Surface classification only needs to keep up with the car, not the render rate.
	GripRefresh -= DeltaSeconds;
	if (GripRefresh <= 0.f)
	{
		GripRefresh = 0.05f;
		UpdateSurfaceGrip();
	}
}
