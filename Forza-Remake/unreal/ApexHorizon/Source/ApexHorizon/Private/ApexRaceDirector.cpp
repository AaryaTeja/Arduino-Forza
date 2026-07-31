// Apex Horizon — race director.

#include "ApexRaceDirector.h"

#include "ApexAIDriver.h"
#include "ApexMaterialLibrary.h"
#include "ApexMath.h"
#include "ApexMeshBuilder.h"
#include "ApexTrackSpline.h"
#include "ApexVehiclePawn.h"
#include "ApexWorldActor.h"

#include "Materials/MaterialInstanceDynamic.h"
#include "ProceduralMeshComponent.h"

using namespace ApexMath;

namespace
{
	/** How many gates ahead of the player are shown. */
	constexpr int32 VisibleGates = 2;
}

AApexRaceDirector::AApexRaceDirector()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickGroup = TG_PostPhysics;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

void AApexRaceDirector::BuildGates(UApexMaterialLibrary* InMaterials)
{
	if (GatePosts.Num() > 0)
	{
		return;
	}

	GateMaterial = InMaterials ? InMaterials->CreateEmissive(FLinearColor(0.16f, 0.88f, 0.66f), 12.f) : nullptr;

	// Two slim glowing posts read as a gate without a translucent slab blocking the view.
	for (int32 i = 0; i < VisibleGates * 2; ++i)
	{
		UProceduralMeshComponent* Post = NewObject<UProceduralMeshComponent>(this,
			*FString::Printf(TEXT("GatePost_%d"), i));
		Post->SetupAttachment(RootComponent);
		Post->SetMobility(EComponentMobility::Movable);
		Post->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Post->SetCastShadow(false);

		FApexMeshData Mesh;
		Mesh.AddCylinder(FVector::ZeroVector, 20, 12, 550, 10, FQuat::Identity, FColor::White, true);
		Mesh.ComputeNormals();
		Mesh.ToSection(Post, 0, false);
		if (GateMaterial)
		{
			Post->SetMaterial(0, GateMaterial);
		}

		Post->SetVisibility(false);
		Post->RegisterComponent();
		GatePosts.Add(Post);
	}
}

void AApexRaceDirector::Setup(AApexWorldActor* InWorld, UApexMaterialLibrary* InMaterials,
	const TArray<FApexEntrant>& Entries, int32 InLaps, EApexRaceMode InMode)
{
	World = InWorld;
	Mode = InMode;
	Laps = (Mode == EApexRaceMode::FreeRoam) ? MAX_int32 : FMath::Max(1, InLaps);
	Time = 0.0;
	Events.Reset();
	State = EApexRaceState::Idle;

	BuildGates(InMaterials);

	const FApexTrackSpline& Sp = World->GetSpline();
	const TArray<FApexCheckpoint>& Cps = World->GetCheckpoints();
	CheckpointSpacing = Sp.Length / Cps.Num();

	Entrants = Entries;
	for (int32 i = 0; i < Entrants.Num(); ++i)
	{
		FApexEntrant& E = Entrants[i];
		E.Index = i;
		E.Lap = 0;
		E.NextCheckpoint = 0;
		E.Progress = 0.0;
		E.LapStart = 0.0;
		E.LapTimes.Reset();
		E.BestLap = -1.0;
		E.SectorTimes.Reset();
		E.CurrentSectors.Reset();
		E.bFinished = false;
		E.FinishTime = -1.0;
		E.Position = i + 1;
	}

	// grid
	const TArray<FApexPlacement> Slots = World->GridSlots(Entrants.Num());
	for (int32 i = 0; i < Entrants.Num(); ++i)
	{
		FApexEntrant& E = Entrants[i];
		if (!E.Pawn)
		{
			continue;
		}
		E.Pawn->PlaceAt(Slots[i].Location, Slots[i].Rotation);
		if (E.Ai)
		{
			E.Ai->ClearRescue();
		}

		const FApexSplineQuery Q = World->QuerySurfaceUE(Slots[i].Location);
		E.LastS = Q.S;
		E.Progress = Sp.SignedArc(Sp.S[World->GetStartIndex()], Q.S);
	}

	UpdatePositions();
}

void AApexRaceDirector::StartRace(double CountdownSeconds)
{
	if (Mode == EApexRaceMode::FreeRoam)
	{
		State = EApexRaceState::Running;
		Time = 0.0;
		return;
	}
	State = EApexRaceState::Countdown;
	Countdown = CountdownSeconds;
	LastBeep = FMath::CeilToInt32(CountdownSeconds);
	Time = 0.0;
}

bool AApexRaceDirector::AllowDrive() const
{
	return State == EApexRaceState::Running
		|| State == EApexRaceState::Finished
		|| Mode == EApexRaceMode::FreeRoam;
}

const FApexEntrant* AApexRaceDirector::GetPlayer() const
{
	return Entrants.FindByPredicate([](const FApexEntrant& E) { return E.bIsPlayer; });
}

void AApexRaceDirector::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!World || !World->IsBuilt())
	{
		return;
	}

	const double Dt = DeltaSeconds;

	if (State == EApexRaceState::Countdown)
	{
		Countdown -= Dt;
		const int32 N = FMath::CeilToInt32(Countdown);
		if (N < LastBeep)
		{
			LastBeep = N;
			if (N > 0)
			{
				Events.Add({ EApexRaceEventType::Countdown, N, Time, FString() });
			}
		}
		if (Countdown <= 0.0)
		{
			State = EApexRaceState::Running;
			Time = 0.0;
			Events.Add({ EApexRaceEventType::Go, 0, 0.0, FString() });
			for (FApexEntrant& E : Entrants)
			{
				E.LapStart = 0.0;
				E.CurrentSectors.Reset();
			}
		}
		UpdateGates();
		return;
	}

	if (State != EApexRaceState::Running && State != EApexRaceState::Finished)
	{
		return;
	}
	Time += Dt;

	const FApexTrackSpline& Sp = World->GetSpline();

	for (FApexEntrant& E : Entrants)
	{
		if (!E.Pawn)
		{
			continue;
		}

		const FApexSplineQuery Q = World->QuerySurfaceUE(E.Pawn->GetActorLocation());
		double Ds = Sp.SignedArc(E.LastS, Q.S);
		if (FMath::Abs(Ds) > Sp.Length * 0.4)
		{
			Ds = 0.0;    // teleport / respawn guard
		}
		E.Progress += Ds;
		E.LastS = Q.S;

		const FVector Forward = E.Pawn->GetActorForwardVector();
		const FVector Tangent = ApexDirToUE(Sp.Tx[Q.Index], Sp.Ty[Q.Index], Sp.Tz[Q.Index]);
		const double Heading = FVector::DotProduct(Forward, Tangent);
		E.bWrongWay = Heading < -0.35 && FMath::Abs(E.Pawn->GetTelemetry().Speed) > 4.f;
		E.TrackDist = Q.Dist;
		E.HalfWidth = Q.HalfWidth;

		// lift a hopelessly wedged AI car back onto the racing line
		if (E.Ai && E.Ai->NeedsRescue())
		{
			const FApexPlacement Spot = World->RespawnPoint(E.Pawn->GetActorLocation(), 6.0);
			E.Pawn->PlaceAt(Spot.Location, Spot.Rotation);
			E.Ai->ClearRescue();
			E.LastS = World->QuerySurfaceUE(Spot.Location).S;
		}

		if (Mode == EApexRaceMode::FreeRoam || E.bFinished)
		{
			continue;
		}
		CheckProgress(E, Q);
	}

	UpdatePositions();
	UpdateGates();

	if (Mode != EApexRaceMode::FreeRoam && State == EApexRaceState::Running)
	{
		const FApexEntrant* Human = GetPlayer();
		bool bEveryoneDone = true;
		for (const FApexEntrant& E : Entrants)
		{
			bEveryoneDone &= E.bFinished;
		}
		if ((Human && Human->bFinished) || bEveryoneDone)
		{
			State = EApexRaceState::Finished;
			Events.Add({ EApexRaceEventType::RaceOver, 0, Time, FString() });
		}
	}
}

void AApexRaceDirector::CheckProgress(FApexEntrant& E, const FApexSplineQuery& Q)
{
	const TArray<FApexCheckpoint>& Cps = World->GetCheckpoints();
	const int32 N = Cps.Num();
	const double SplineLength = World->GetSpline().Length;

	for (int32 Guard = 0; Guard < N * 2; ++Guard)
	{
		const double TargetProgress = E.Lap * SplineLength + E.NextCheckpoint * CheckpointSpacing;
		if (E.Progress < TargetProgress)
		{
			break;
		}
		// must be somewhere on the circuit corridor to count
		if (Q.Dist > Q.HalfWidth + 40.0)
		{
			break;
		}

		++E.NextCheckpoint;

		const int32 PerSector = FMath::Max(1, FMath::RoundToInt32(static_cast<double>(N) / SectorCount));
		if (E.NextCheckpoint % PerSector == 0 && E.NextCheckpoint < N)
		{
			E.CurrentSectors.Add(Time - E.LapStart);
		}

		if (E.NextCheckpoint >= N)
		{
			E.NextCheckpoint = 0;
			++E.Lap;

			const double LapTime = Time - E.LapStart;
			E.LapStart = Time;
			E.LapTimes.Add(LapTime);
			E.CurrentSectors.Add(LapTime);
			E.SectorTimes = E.CurrentSectors;
			E.CurrentSectors.Reset();

			if (E.BestLap < 0.0 || LapTime < E.BestLap)
			{
				E.BestLap = LapTime;
				if (E.bIsPlayer)
				{
					Events.Add({ EApexRaceEventType::BestLap, 0, LapTime, E.Name });
				}
			}
			Events.Add({ EApexRaceEventType::Lap, E.Lap, LapTime, E.Name });

			if (E.Lap >= Laps)
			{
				E.bFinished = true;
				E.FinishTime = Time;
				int32 Place = 1;
				for (const FApexEntrant& Other : Entrants)
				{
					if (Other.bFinished && Other.FinishTime < E.FinishTime)
					{
						++Place;
					}
				}
				Events.Add({ EApexRaceEventType::Finish, Place, Time, E.Name });
				break;
			}
		}
		else if (E.bIsPlayer)
		{
			Events.Add({ EApexRaceEventType::Checkpoint, E.NextCheckpoint, Time, FString() });
		}
	}
}

void AApexRaceDirector::UpdatePositions()
{
	Standings.Reset(Entrants.Num());
	for (int32 i = 0; i < Entrants.Num(); ++i)
	{
		Standings.Add(i);
	}

	Standings.Sort([this](int32 A, int32 B)
	{
		const FApexEntrant& Ea = Entrants[A];
		const FApexEntrant& Eb = Entrants[B];
		if (Ea.bFinished && Eb.bFinished) { return Ea.FinishTime < Eb.FinishTime; }
		if (Ea.bFinished) { return true; }
		if (Eb.bFinished) { return false; }
		return Ea.Progress > Eb.Progress;
	});

	for (int32 i = 0; i < Standings.Num(); ++i)
	{
		Entrants[Standings[i]].Position = i + 1;
	}

	if (Standings.Num() == 0)
	{
		return;
	}

	const FApexEntrant& Leader = Entrants[Standings[0]];
	for (int32 i = 0; i < Standings.Num(); ++i)
	{
		FApexEntrant& E = Entrants[Standings[i]];
		const double GapDist = Leader.Progress - E.Progress;
		const double Speed = E.Pawn ? FMath::Max<double>(FMath::Abs(E.Pawn->GetTelemetry().Speed), 8.0) : 8.0;
		E.GapToLeader = (E.bFinished && Leader.bFinished)
			? E.FinishTime - Leader.FinishTime
			: GapDist / Speed;
		E.GapAhead = (i > 0)
			? (Entrants[Standings[i - 1]].Progress - E.Progress) / Speed
			: 0.0;
	}
}

void AApexRaceDirector::UpdateGates()
{
	const FApexEntrant* P = GetPlayer();
	if (!P || !P->Pawn || Mode == EApexRaceMode::FreeRoam || P->bFinished)
	{
		for (UProceduralMeshComponent* Post : GatePosts)
		{
			if (Post) { Post->SetVisibility(false); }
		}
		return;
	}

	const TArray<FApexCheckpoint>& Cps = World->GetCheckpoints();
	const FVector PlayerPos = P->Pawn->GetActorLocation();

	for (int32 K = 0; K < VisibleGates; ++K)
	{
		const FApexCheckpoint& Cp = Cps[(P->NextCheckpoint + K) % Cps.Num()];
		const double Dist = FVector::Dist2D(Cp.Position, PlayerPos);
		const bool bVisible = Dist <= 42000.0;   // 420 m

		for (int32 Side = 0; Side < 2; ++Side)
		{
			UProceduralMeshComponent* Post = GatePosts[K * 2 + Side];
			if (!Post)
			{
				continue;
			}
			Post->SetVisibility(bVisible);
			if (!bVisible)
			{
				continue;
			}
			const double Lateral = (Side == 0 ? 1.0 : -1.0) * Cp.HalfWidth * APEX_TO_UE;
			Post->SetWorldLocation(Cp.Position + Cp.Right * Lateral);
		}
	}
}

double AApexRaceDirector::DistanceToNextCheckpoint() const
{
	const FApexEntrant* P = GetPlayer();
	if (!P || !P->Pawn || !World)
	{
		return 0.0;
	}
	const TArray<FApexCheckpoint>& Cps = World->GetCheckpoints();
	const FApexCheckpoint& Cp = Cps[P->NextCheckpoint % Cps.Num()];
	return FVector::Dist2D(Cp.Position, P->Pawn->GetActorLocation()) / APEX_TO_UE;
}

TArray<FApexRaceEvent> AApexRaceDirector::ConsumeEvents()
{
	TArray<FApexRaceEvent> Out = MoveTemp(Events);
	Events.Reset();
	return Out;
}

void AApexRaceDirector::Reset()
{
	State = EApexRaceState::Idle;
	Events.Reset();
	for (UProceduralMeshComponent* Post : GatePosts)
	{
		if (Post) { Post->SetVisibility(false); }
	}
}
