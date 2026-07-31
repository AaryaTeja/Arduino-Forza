// Apex Horizon — racing AI.
//
// Rivals drive the same pawn the player does — same physics, same grip, same
// collisions. There is no rubber-banding and no scripted path: pure-pursuit steering
// onto a pre-computed racing line, a lookahead braking solver, and lateral negotiation
// with nearby cars.

#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "ApexMath.h"
#include "ApexAIDriver.generated.h"

class AApexVehiclePawn;
class AApexWorldActor;

UCLASS()
class APEXHORIZON_API UApexAIDriver : public UObject
{
	GENERATED_BODY()

public:
	void Initialise(AApexVehiclePawn* InPawn, AApexWorldActor* InWorld, double Skill, double Aggression, int32 Seed);

	/** @param bAllowDrive false during the countdown: hold the brake on the grid. */
	void Update(float DeltaSeconds, const TArray<AApexVehiclePawn*>& Rivals, bool bAllowDrive);

	/** Racing-line speed at an arc length, already scaled by this driver's pace. */
	double SpeedAt(double S) const;

	/** True when the car has made no progress for long enough to need lifting back on. */
	bool NeedsRescue() const { return bNeedsRescue; }
	void ClearRescue();

	double GetArcLength() const { return S; }

private:
	void DriveReverse(const struct FApexSplineQuery& Q);
	void Negotiate(float DeltaSeconds, const TArray<AApexVehiclePawn*>& Rivals,
		const struct FApexSplineQuery& Q, double Speed);
	void Apply(bool bAllowDrive);

	UPROPERTY() TObjectPtr<AApexVehiclePawn> Pawn = nullptr;
	UPROPERTY() TObjectPtr<AApexWorldActor> World = nullptr;

	ApexMath::FRng Rng { 1u };

	double Skill = 1.0;
	double Aggression = 0.6;
	double SpeedScale = 1.0;
	double TopSpeed = 80.0;

	double PreferredSide = 1.0;
	double BrakePoint = 0.94;
	double ThrottleSmooth = 0.8;

	double Bias = 0.0;
	double BiasTarget = 0.0;
	double BlockedSpeedCap = TNumericLimits<double>::Max();
	bool bBlocked = false;

	double S = 0.0;
	double StuckTime = 0.0;
	double ReverseTimer = 0.0;
	double MistakeTimer = 6.0;
	double Mistake = 0.0;

	double WatchS = 0.0;
	bool bHasWatch = false;
	double NoProgress = 0.0;
	bool bNeedsRescue = false;

	double OutThrottle = 0.0;
	double OutBrake = 0.0;
	double OutSteer = 0.0;
};
