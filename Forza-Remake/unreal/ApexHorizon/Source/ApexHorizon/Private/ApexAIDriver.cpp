// Apex Horizon — racing AI.

#include "ApexAIDriver.h"

#include "ApexCarData.h"
#include "ApexTrackSpline.h"
#include "ApexVehiclePawn.h"
#include "ApexWorldActor.h"

using namespace ApexMath;

void UApexAIDriver::Initialise(AApexVehiclePawn* InPawn, AApexWorldActor* InWorld,
	double InSkill, double InAggression, int32 Seed)
{
	Pawn = InPawn;
	World = InWorld;
	Skill = InSkill;
	Aggression = InAggression;
	Rng = FRng(static_cast<uint32>(Seed * 7919 + 13));

	// small per-driver personality
	PreferredSide = Rng() > 0.5 ? 1.0 : -1.0;
	BrakePoint = 0.94 + (Rng() - 0.5) * 0.07;
	ThrottleSmooth = 0.65 + Rng() * 0.3;
	MistakeTimer = 4.0 + Rng() * 12.0;

	// The shared racing line is solved at a reference lateral acceleration; rescale it
	// to what this car's tyres can actually hold, and cap it at its real top speed.
	const FApexSpec& Spec = Pawn->GetSpec();
	const double LatAccel = 9.81 * Spec.Grip * 0.72;   // a margin below the tyre limit
	SpeedScale = FMath::Sqrt(LatAccel / APEX_REFERENCE_LAT_ACCEL);
	TopSpeed = FApexCatalogue::EstimateTopSpeed(Spec) * 1.02;
}

double UApexAIDriver::SpeedAt(double InS) const
{
	if (!World)
	{
		return 0.0;
	}
	return FMath::Min(World->LineSpeedAt(InS) * SpeedScale * Skill, TopSpeed);
}

void UApexAIDriver::Update(float DeltaSeconds, const TArray<AApexVehiclePawn*>& Rivals, bool bAllowDrive)
{
	if (!Pawn || !World)
	{
		return;
	}

	const double Dt = DeltaSeconds;
	const FApexTrackSpline& Sp = World->GetSpline();
	const FApexTelemetry& T = Pawn->GetTelemetry();

	const FVector Position = Pawn->GetActorLocation();
	const FApexSplineQuery Q = World->QuerySurfaceUE(Position);
	S = Q.S;

	const double Speed = FMath::Max<double>(T.Speed, 0.0);
	const double Grip = 1.0 - World->Wetness * 0.22;

	// Watchdog: reversing out of a wedge does not always work, so if the car has not
	// actually advanced along the circuit for a while, ask to be lifted back on.
	if (!bHasWatch)
	{
		WatchS = Q.S;
		bHasWatch = true;
	}
	if (Sp.SignedArc(WatchS, Q.S) > 12.0)
	{
		WatchS = Q.S;
		NoProgress = 0.0;
	}
	else if (bAllowDrive)
	{
		NoProgress += Dt;
		if (NoProgress > 8.0)
		{
			bNeedsRescue = true;
			NoProgress = 0.0;
		}
	}

	/* ── stuck / recovery ── */
	const FVector Forward = Pawn->GetActorForwardVector();
	const bool bWayOff = FMath::Abs(Q.SignedDist) > Q.HalfWidth + 14.0;

	if ((FMath::Abs(T.Speed) < 1.4 && bAllowDrive) || T.Upright < 0.35 || (bWayOff && FMath::Abs(T.Speed) < 6.f))
	{
		StuckTime += Dt;
	}
	else
	{
		StuckTime = FMath::Max(0.0, StuckTime - Dt * 2.0);
	}
	if (StuckTime > 1.6 && ReverseTimer <= 0.0)
	{
		ReverseTimer = 1.5;
	}
	if (ReverseTimer > 0.0)
	{
		ReverseTimer -= Dt;
		DriveReverse(Q);
		Apply(bAllowDrive);
		return;
	}

	/* ── occasional imperfection so the field isn't robotic ── */
	MistakeTimer -= Dt;
	if (MistakeTimer <= 0.0)
	{
		MistakeTimer = 7.0 + Rng() * 16.0;
		Mistake = (Rng() - 0.35) * 0.12 * (2.0 - Skill);
	}
	Mistake = Damp(Mistake, 0.0, 0.5, Dt);

	/* ── lateral negotiation ── */
	Negotiate(DeltaSeconds, Rivals, Q, Speed);

	/* ── pure pursuit ── */
	const double Lookahead = FMath::Clamp(7.0 + Speed * 0.62, 9.0, 52.0);
	const FVector Target = World->LinePoint(Q.S + Lookahead, Bias);

	const FVector ToTarget = Target - Position;
	const double LocalZ = FVector::DotProduct(ToTarget, Forward) / APEX_TO_UE;
	const double LocalX = FVector::DotProduct(ToTarget, Pawn->GetActorRightVector()) / APEX_TO_UE;
	const double Alpha = FMath::Atan2(LocalX, FMath::Max(LocalZ, 0.5));

	const double Wheelbase = Pawn->GetSpec().Car.Body.Wheelbase;
	const double Geometric = FMath::Atan2(2.0 * Wheelbase * FMath::Sin(Alpha), FMath::Max(Lookahead, 1.0));

	// undo the movement component's own speed-sensitive steering reduction
	double SpeedEase = 1.0;
	if (const UChaosWheeledVehicleMovementComponent* Move = Pawn->GetVehicleMovement())
	{
		if (const FRichCurve* Curve = Move->SteeringSetup.SteeringCurve.GetRichCurveConst())
		{
			SpeedEase = FMath::Max<double>(Curve->Eval(FMath::Abs(T.Speed) * 2.23694f), 0.15);
		}
	}
	double Steer = Geometric / FMath::Max(Pawn->GetSpec().SteerLock * SpeedEase, 0.05);

	// damp the yaw so it doesn't wander at speed (+yaw rate = turning right in Unreal)
	Steer -= T.YawRate * FMath::Clamp(Speed * 0.006, 0.0, 0.10);
	Steer += Mistake;
	OutSteer = FMath::Clamp(Steer, -1.0, 1.0);

	/* ── speed target with lookahead braking ── */
	double VLimit = SpeedAt(Q.S + 6.0);
	const double Decel = 10.5 * Grip * BrakePoint * Lerp(0.85, 1.12, Skill - 0.85);
	for (double D = 12.0; D <= 240.0; D += 12.0)
	{
		const double VAt = SpeedAt(Q.S + D);
		const double Reachable = FMath::Sqrt(VAt * VAt + 2.0 * FMath::Max(Decel, 3.0) * D);
		VLimit = FMath::Min(VLimit, Reachable);
	}
	VLimit *= Grip;

	// back off when the nose isn't pointing where we want to go, and when already wide
	VLimit *= 1.0 - Clamp01((FMath::Abs(Alpha) - 0.10) / 0.45) * 0.50;
	const double Wide = Clamp01((FMath::Abs(Q.SignedDist) - (Q.HalfWidth - 3.0)) / 4.0);
	VLimit *= 1.0 - Wide * 0.35;
	if (!Q.bFar && FMath::Abs(Q.SignedDist) > Q.HalfWidth)
	{
		VLimit = FMath::Min(VLimit, 26.0);
	}
	if (bBlocked)
	{
		VLimit = FMath::Min(VLimit, BlockedSpeedCap);
	}

	const double Err = VLimit - Speed;
	double Throttle = 0.0, Brake = 0.0;
	if (Err > 0.4)
	{
		Throttle = Clamp01(Err * 0.35);
	}
	else if (Err < -0.8)
	{
		Brake = Clamp01(-Err * 0.24);
	}

	// ease off mid-corner if the car is already sliding
	const double Slide = Clamp01((FMath::Abs(T.DriftAngle) - 0.22) / 0.35);
	Throttle *= 1.0 - Slide * 0.55;

	OutThrottle = Damp(OutThrottle, Throttle, Lerp(6.0, 16.0, ThrottleSmooth), Dt);
	OutBrake = Damp(OutBrake, Brake, 22.0, Dt);

	Apply(bAllowDrive);
}

void UApexAIDriver::ClearRescue()
{
	bNeedsRescue = false;
	ReverseTimer = 0.0;
	StuckTime = 0.0;
	bHasWatch = false;
	NoProgress = 0.0;
	OutThrottle = 0.0;
	OutBrake = 0.0;
	OutSteer = 0.0;
}

void UApexAIDriver::DriveReverse(const FApexSplineQuery& Q)
{
	// back up and point the nose at the racing line again
	const FVector Target = World->LinePoint(Q.S + 14.0, 0.0);
	const FVector ToTarget = Target - Pawn->GetActorLocation();
	const double LocalX = FVector::DotProduct(ToTarget, Pawn->GetActorRightVector()) / APEX_TO_UE;
	const double LocalZ = FVector::DotProduct(ToTarget, Pawn->GetActorForwardVector()) / APEX_TO_UE;

	if (LocalZ > 0.0 && FMath::Abs(LocalX) < 6.0)
	{
		// facing the right way again: drive out forwards
		OutThrottle = 0.55;
		OutBrake = 0.0;
		OutSteer = FMath::Clamp(LocalX * 0.2, -1.0, 1.0);
		ReverseTimer = FMath::Min(ReverseTimer, 0.1);
	}
	else
	{
		OutThrottle = 0.0;
		OutBrake = 0.75;                  // held brake reverses via the auto gearbox
		OutSteer = FMath::Clamp(-LocalX * 0.2, -1.0, 1.0);
	}
	StuckTime = 0.0;
}

void UApexAIDriver::Negotiate(float DeltaSeconds, const TArray<AApexVehiclePawn*>& Rivals,
	const FApexSplineQuery& Q, double Speed)
{
	const FApexTrackSpline& Sp = World->GetSpline();
	const double LineOffset = World->GetLineOffset(Q.Index);
	const double Limit = FMath::Max(1.0, Q.HalfWidth - 1.8);

	double Target = 0.0;
	double Cap = TNumericLimits<double>::Max();
	bBlocked = false;

	for (AApexVehiclePawn* Other : Rivals)
	{
		if (!Other || Other == Pawn)
		{
			continue;
		}

		const FApexSplineQuery Oq = World->QuerySurfaceUE(Other->GetActorLocation());
		const double Ds = Sp.SignedArc(Q.S, Oq.S);
		if (Ds < -8.0 || Ds > 55.0)
		{
			continue;
		}

		const double LateralGap = Oq.SignedDist - Q.SignedDist;
		const double Closing = Speed - FMath::Max<double>(Other->GetTelemetry().Speed, 0.0);

		if (Ds > 2.0 && FMath::Abs(LateralGap) < 3.6)
		{
			// car directly ahead: pick the side with more room
			const double TheirSide = Oq.SignedDist;
			const double RoomLeft = -Limit - TheirSide;
			const double RoomRight = Limit - TheirSide;
			const double Side = FMath::Abs(RoomRight) > FMath::Abs(RoomLeft) ? 1.0 : -1.0;
			const double Urgency = SmoothStep(46.0, 12.0, Ds) * Clamp01(0.35 + Aggression);
			Target += Side * Limit * 0.85 * Urgency;

			// if we can't get past yet, match their pace rather than punt them
			if (Ds < 11.0 && Closing > 1.5)
			{
				Cap = FMath::Min(Cap, FMath::Max<double>(Other->GetTelemetry().Speed * 0.96, 6.0));
				BlockedSpeedCap = Cap;
				bBlocked = true;
			}
		}
		else if (FMath::Abs(Ds) <= 6.0 && FMath::Abs(LateralGap) < 3.2)
		{
			// side by side: leave room, don't turn in
			const double Sign = LateralGap != 0.0 ? FMath::Sign(LateralGap) : PreferredSide;
			Target += -Sign * Limit * 0.5;
		}
	}

	// relax back to the racing line when the road is clear
	if (Target == 0.0)
	{
		BiasTarget = Damp(BiasTarget, 0.0, 1.6, DeltaSeconds);
	}
	else
	{
		BiasTarget = FMath::Clamp(Target, -Limit - LineOffset, Limit - LineOffset);
	}

	Bias = Damp(Bias, BiasTarget, 2.2, DeltaSeconds);
}

void UApexAIDriver::Apply(bool bAllowDrive)
{
	if (!bAllowDrive)
	{
		Pawn->SetControls(0.f, 1.f, 0.f, 1.f);
		OutThrottle = 0.0;
		OutBrake = 0.0;
		return;
	}

	Pawn->SetControls(
		static_cast<float>(Clamp01(OutThrottle)),
		static_cast<float>(Clamp01(OutBrake)),
		static_cast<float>(FMath::Clamp(OutSteer, -1.0, 1.0)),
		0.f);
}
