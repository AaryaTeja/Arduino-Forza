// Apex Horizon — the vehicle.
//
// Chaos Vehicles normally require a skeletal mesh with named wheel bones. Everything
// here is generated at runtime, so `UApexVehicleMovementComponent` drops that
// requirement and positions the wheels from explicit offsets instead, letting a
// procedural mesh act as the chassis.

#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "ChaosVehicleWheel.h"
#include "ChaosWheeledVehicleMovementComponent.h"
#include "ApexCarData.h"
#include "ApexVehiclePawn.generated.h"

class AApexWorldActor;
class UApexMaterialLibrary;
class UCameraComponent;
class UProceduralMeshComponent;
class USpotLightComponent;
class USpringArmComponent;

/**
 * Chaos reads a wheel's physical configuration from its class default object, not from
 * the per-vehicle instance, so wheel geometry and suspension rates have to live in the
 * class. Each car therefore gets its own front and rear wheel class, all of which pull
 * their numbers from the catalogue entry named in the constructor.
 *
 * Anything that varies with the player's build rather than the car — tyre grip, brake
 * torque, steering lock — is applied per instance at runtime instead.
 */
UCLASS(Abstract)
class APEXHORIZON_API UApexWheelBase : public UChaosVehicleWheel
{
	GENERATED_BODY()

public:
	/** Fill this wheel's defaults from the catalogue entry for `CarId`. */
	void InitFromCar(FName CarId, bool bFront);
};

UCLASS() class APEXHORIZON_API UApexWheelKestrelFront : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelKestrelFront() { InitFromCar("kestrel", true); } };
UCLASS() class APEXHORIZON_API UApexWheelKestrelRear : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelKestrelRear() { InitFromCar("kestrel", false); } };

UCLASS() class APEXHORIZON_API UApexWheelAureliaFront : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelAureliaFront() { InitFromCar("aurelia", true); } };
UCLASS() class APEXHORIZON_API UApexWheelAureliaRear : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelAureliaRear() { InitFromCar("aurelia", false); } };

UCLASS() class APEXHORIZON_API UApexWheelBaronFront : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelBaronFront() { InitFromCar("baron", true); } };
UCLASS() class APEXHORIZON_API UApexWheelBaronRear : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelBaronRear() { InitFromCar("baron", false); } };

UCLASS() class APEXHORIZON_API UApexWheelVulcanFront : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelVulcanFront() { InitFromCar("vulcan", true); } };
UCLASS() class APEXHORIZON_API UApexWheelVulcanRear : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelVulcanRear() { InitFromCar("vulcan", false); } };

UCLASS() class APEXHORIZON_API UApexWheelMistralFront : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelMistralFront() { InitFromCar("mistral", true); } };
UCLASS() class APEXHORIZON_API UApexWheelMistralRear : public UApexWheelBase
{ GENERATED_BODY() public: UApexWheelMistralRear() { InitFromCar("mistral", false); } };

/** The wheel class for a car, falling back to the starter car for unknown ids. */
APEXHORIZON_API TSubclassOf<UChaosVehicleWheel> ApexWheelClassFor(FName CarId, bool bFront);

UCLASS()
class APEXHORIZON_API UApexVehicleMovementComponent : public UChaosWheeledVehicleMovementComponent
{
	GENERATED_BODY()

public:
	/**
	 * Same checks as the base class minus the bone-name requirement: wheels here are
	 * placed by offset against a procedural chassis, not by skeleton.
	 */
	virtual bool CanCreateVehicle() const override;
};

/** Live readouts the HUD, audio and AI all share. */
USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexTelemetry
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Speed = 0.f;        // m/s, signed along forward
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Rpm = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") int32 Gear = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Throttle = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Brake = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Steer = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float YawRate = 0.f;      // rad/s, +ve turning right
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float DriftAngle = 0.f;   // rad between heading and velocity
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Upright = 1.f;      // 1 on wheels, -1 on the roof
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float SlipAmount = 0.f;   // 0..1 worst wheel
	UPROPERTY(BlueprintReadOnly, Category = "Apex") int32 WheelsOnGround = 4;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") bool bOnRoad = true;
};

UCLASS()
class APEXHORIZON_API AApexVehiclePawn : public APawn
{
	GENERATED_BODY()

public:
	AApexVehiclePawn();

	/**
	 * Build the body, wheels and drivetrain for `InSpec`.
	 * Must run before the components register — spawn the pawn deferred and call this
	 * between SpawnActorDeferred and FinishSpawningActor.
	 */
	void Configure(const FApexSpec& InSpec, UApexMaterialLibrary* InMaterials, AApexWorldActor* InWorld);

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	/** Driver inputs, all 0..1 except steer which is -1..1. */
	void SetControls(float Throttle, float Brake, float Steer, float Handbrake);

	void ShiftUp();
	void ShiftDown();
	void SetManualGearbox(bool bManual);
	bool IsManualGearbox() const;

	/** Drop the car back onto the road, upright and pointing the right way. */
	void ResetToTrack();

	/** Place the car without disturbing the rest of the simulation. */
	void PlaceAt(const FVector& Location, const FRotator& Rotation);

	void SetHeadlights(bool bOn);
	bool AreHeadlightsOn() const { return bHeadlights; }

	const FApexSpec& GetSpec() const { return Spec; }
	const FApexTelemetry& GetTelemetry() const { return Telemetry; }

	/** Speed in m/s along the car's forward axis. */
	float GetSpeed() const { return Telemetry.Speed; }

	UChaosWheeledVehicleMovementComponent* GetVehicleMovement() const { return Movement; }
	UCameraComponent* GetCamera() const { return Camera; }
	USpringArmComponent* GetSpringArm() const { return SpringArm; }

	/** Cycle chase → hood → bumper → cockpit. */
	void CycleCamera();
	void SetLookBack(bool bLookBack);

	/** Driver-facing name, used by the HUD and standings. */
	UPROPERTY() FString DriverName;
	UPROPERTY() FLinearColor LiveryColour = FLinearColor::White;
	UPROPERTY() bool bIsPlayer = false;

private:
	void BuildBodyMesh();
	void BuildWheelMeshes();
	void ConfigureDrivetrain();
	void ApplyRuntimeTuning();
	void UpdateWheelVisuals();
	void UpdateTelemetry(float DeltaSeconds);
	void UpdateSurfaceGrip();
	void ApplyCameraMode();

	UPROPERTY() TObjectPtr<UProceduralMeshComponent> Chassis = nullptr;
	UPROPERTY() TArray<TObjectPtr<UProceduralMeshComponent>> WheelMeshes;
	UPROPERTY() TObjectPtr<UApexVehicleMovementComponent> Movement = nullptr;
	UPROPERTY() TObjectPtr<USpringArmComponent> SpringArm = nullptr;
	UPROPERTY() TObjectPtr<UCameraComponent> Camera = nullptr;
	UPROPERTY() TArray<TObjectPtr<USpotLightComponent>> Headlights;

	UPROPERTY() TObjectPtr<UApexMaterialLibrary> Materials = nullptr;
	UPROPERTY() TObjectPtr<AApexWorldActor> World = nullptr;
	UPROPERTY() TObjectPtr<class UMaterialInstanceDynamic> PaintMid = nullptr;
	UPROPERTY() TObjectPtr<class UMaterialInstanceDynamic> BrakeMid = nullptr;
	UPROPERTY() TObjectPtr<class UMaterialInstanceDynamic> TailMid = nullptr;
	UPROPERTY() TObjectPtr<class UMaterialInstanceDynamic> HeadMid = nullptr;

	FApexSpec Spec;
	FApexTelemetry Telemetry;

	float InputThrottle = 0.f;
	float InputBrake = 0.f;
	float InputSteer = 0.f;
	float InputHandbrake = 0.f;

	int32 CameraMode = 0;
	bool bLookBack = false;
	bool bHeadlights = false;
	bool bConfigured = false;
	bool bTuningApplied = false;
	float BrakeGlow = 0.f;
	float GripRefresh = 0.f;
};
