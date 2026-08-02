// Apex Horizon — vehicle catalogue, tuning model and the derived spec both the
// simulation and the UI read from.
//
// Units are SI: kilograms, metres, newton-metres, radians. Suspension stiffness is an
// acceleration-per-metre (force = stiffness * compression * mass), as in the original.

#pragma once

#include "CoreMinimal.h"
#include "ApexCarData.generated.h"

UENUM(BlueprintType)
enum class EApexDrivetrain : uint8
{
	FWD,
	RWD,
	AWD
};

UENUM(BlueprintType)
enum class EApexBodyProfile : uint8
{
	Hatch,
	Coupe,
	SUV,
	Super,
	GT3
};

/** Normalised torque curve, sampled against rpm / redline. */
APEXHORIZON_API double ApexTorqueFactor(double RpmFraction);

/** Lateral acceleration the shared racing line is solved at; AI rescale from this. */
static constexpr double APEX_REFERENCE_LAT_ACCEL = 11.5;

USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexTyreCompound
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Apex") FName Id;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FString Label;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Grip = 1.28f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float WetGrip = 0.92f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Offroad = 0.58f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Warmth = 1.0f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FString Note;
};

USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexBodySpec
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Length = 4.28f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Width = 1.80f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Wheelbase = 2.62f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float TrackF = 1.55f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float TrackR = 1.53f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float WheelRadius = 0.315f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float WheelWidth = 0.225f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float RideHeight = 0.155f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") EApexBodyProfile Profile = EApexBodyProfile::Hatch;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float WingSize = 0.35f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FLinearColor Colour = FLinearColor::White;
};

USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexSuspensionSpec
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Stiffness = 34.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Travel = 0.19f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Rest = 0.30f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Compression = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Relaxation = 0.f;
};

USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexEngineSpec
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Apex") float PeakTorque = 320.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Redline = 6800.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Idle = 850.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") int32 Cylinders = 4;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Turbo = 0.75f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float RevInertia = 0.24f;
};

/** One entry in the catalogue. Immutable reference data. */
USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexCar
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Apex") FName Id;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FString Name;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FString Brand;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FString Klass;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") int32 Price = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FString Blurb;

	UPROPERTY(BlueprintReadOnly, Category = "Apex") EApexDrivetrain Drivetrain = EApexDrivetrain::FWD;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Mass = 1185.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float ComHeight = -0.14f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FApexEngineSpec Engine;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") TArray<float> Gears;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float ReverseGear = 3.55f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float FinalDrive = 4.10f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float DriveEfficiency = 0.90f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float CdA = 0.74f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float DownforceCoef = 0.28f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float BrakeStrength = 0.34f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float BrakeBias = 0.66f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float SteerLock = 0.60f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float TyreGripBase = 1.0f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float OffroadBonus = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float ShiftTimeBase = 0.19f;

	UPROPERTY(BlueprintReadOnly, Category = "Apex") FApexBodySpec Body;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FApexSuspensionSpec Suspension;
};

/** Player-chosen upgrade levels, 0..5 each. */
USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexUpgrades
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadWrite, Category = "Apex") int32 Engine = 0;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") int32 Gearbox = 0;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") int32 Tyres = 0;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") int32 Brakes = 0;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") int32 Weight = 0;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") int32 Aero = 0;
};

/** Continuous tuning sliders, each 0..1. */
USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexTune
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadWrite, Category = "Apex") float FinalDrive = 0.5f;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") float Downforce = 0.5f;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") float BrakeBias = 0.5f;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") float RideHeight = 0.5f;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") float ArbFront = 0.5f;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") float ArbRear = 0.5f;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") float SteerLock = 0.5f;
};

/** A car plus the player's build: paint, tyres, upgrades and tune. */
USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexBuild
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadWrite, Category = "Apex") FName CarId = NAME_None;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") FName TyreId = FName("sport");
	UPROPERTY(BlueprintReadWrite, Category = "Apex") FLinearColor Paint = FLinearColor(0.78f, 0.06f, 0.11f);
	/** 0 gloss, 1 metallic, 2 pearl, 3 matte. */
	UPROPERTY(BlueprintReadWrite, Category = "Apex") int32 Finish = 1;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") bool bStripes = false;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") FApexUpgrades Upgrades;
	UPROPERTY(BlueprintReadWrite, Category = "Apex") FApexTune Tune;
};

/** Everything the simulation and HUD need, after upgrades and tune are folded in. */
USTRUCT(BlueprintType)
struct APEXHORIZON_API FApexSpec
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Apex") FApexCar Car;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FApexBuild Build;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") FApexTyreCompound Tyre;

	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Mass = 1185.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float PeakTorque = 320.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float FinalDrive = 4.10f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float Grip = 1.28f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float BrakeStrength = 0.34f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float DownforceCoef = 0.28f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float CdA = 0.74f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float ShiftTime = 0.19f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float PowerKw = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float BrakeBias = 0.55f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float RideHeight = 0.11f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float SteerLock = 0.6f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float ArbFront = 0.5f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float ArbRear = 0.5f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float WetGrip = 0.92f;
	UPROPERTY(BlueprintReadOnly, Category = "Apex") float OffroadGrip = 0.58f;
};

/** Static access to the catalogue. */
class APEXHORIZON_API FApexCatalogue
{
public:
	static const TArray<FApexCar>& Cars();
	static const FApexCar* FindCar(FName Id);
	static const FApexCar& CarAt(int32 Index);

	static const TArray<FApexTyreCompound>& Tyres();
	static const FApexTyreCompound& FindTyre(FName Id);

	static const TArray<FLinearColor>& PaintPresets();

	/** Resolve a car + build into the concrete numbers the simulation and UI both use. */
	static FApexSpec ResolveSpec(const FApexCar& Car, const FApexBuild& Build);

	static double EstimatePeakPowerKw(double PeakTorque, double Redline);
	/** Solve drag-limited top speed in top gear, m/s. */
	static double EstimateTopSpeed(const FApexSpec& Spec);
	/** 100–999 performance index, Forza-style. */
	static int32 PerformanceIndex(const FApexSpec& Spec);

	/** Driver name for AI entrant `Index`. */
	static FString AiName(int32 Index);
};
