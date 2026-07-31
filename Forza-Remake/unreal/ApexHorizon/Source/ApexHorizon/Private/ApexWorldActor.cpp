// Apex Horizon — world assembly.

#include "ApexWorldActor.h"

#include "ApexCarData.h"
#include "ApexHorizon.h"
#include "ApexMaterialLibrary.h"
#include "ApexMath.h"
#include "ApexMeshBuilder.h"
#include "ApexProps.h"
#include "ApexRoadBuilder.h"
#include "ApexTerrain.h"

#include "Components/BoxComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/PointLightComponent.h"
#include "Components/SpotLightComponent.h"
#include "ProceduralMeshComponent.h"

using namespace ApexMath;
using namespace ApexWorld;

namespace
{
	/**
	 * Horizon Ridge circuit — a ~4.9 km closed loop that leaves the start straight in open
	 * country, crosses the gorge on the arch bridge, sweeps the northern plateau, bores
	 * through Ridgeline tunnel on the east side, then drops into the city grid before the
	 * run back to the line.
	 */
	const TArray<FVector2D>& TrackControlPoints()
	{
		static const TArray<FVector2D> Points = {
			{ -560, -640 }, { -700, -400 }, { -780, -120 }, { -760,  160 },
			{ -660,  380 },  // gorge crossing — bridge
			{ -420,  640 }, { -100,  620 }, {  250,  580 }, {  520,  430 },
			{  700,  200 }, {  760,  -60 },  // Ridgeline tunnel
			{  700, -300 }, {  520, -470 },  // city
			{  300, -560 }, {   60, -600 }, { -180, -700 }, { -400, -760 },
		};
		return Points;
	}

	/** World-space anchor used to locate the tunnel section on the spline. */
	constexpr double TunnelAnchorX = 752.0;
	constexpr double TunnelAnchorZ = -30.0;
	constexpr double TunnelHalfLength = 105.0;

	constexpr int32 CheckpointCount = 18;
}

AApexWorldActor::AApexWorldActor()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	// The world is generated once at the origin and never moves. A static root is what
	// lets the terrain, road and prop components be static too — which is what keeps
	// virtual shadow map pages cached instead of being invalidated every frame — and a
	// movable root would refuse to parent them at all.
	RootComponent->SetMobility(EComponentMobility::Static);
	SetActorEnableCollision(true);
}

void AApexWorldActor::BuildWorld(UApexMaterialLibrary* InMaterials, double PropDensity)
{
	if (bBuilt)
	{
		return;
	}
	Materials = InMaterials;
	const double StartTime = FPlatformTime::Seconds();

	/* ── 1. centreline ── */
	Spline = MakeShared<FApexTrackSpline>(TrackControlPoints(), 3.0);
	FApexTrackSpline& Sp = *Spline;

	/* ── 2. section flags ── */
	for (int32 i = 0; i < Sp.Count; ++i)
	{
		double D2 = 0.0, T = 0.0;
		SegDist2(Sp.X[i], Sp.Z[i], CanyonAx, CanyonAz, CanyonBx, CanyonBz, D2, T);
		const double Taper = 1.0 - SmoothStep(CanyonTaperFrom, 1.0, T);
		if (FMath::Sqrt(D2) < 95.0 && Taper > 0.35)
		{
			Sp.Flags[i] |= FApexTrackSpline::FLAG_BRIDGE;
		}

		const double Cd = FMath::Sqrt(FMath::Square(Sp.X[i] - CityX) + FMath::Square(Sp.Z[i] - CityZ));
		if (Cd < CityRadius)
		{
			Sp.Flags[i] |= FApexTrackSpline::FLAG_CITY;
		}
	}
	{
		// tunnel: a fixed arc either side of the anchor point
		TunnelAnchorIndex = Sp.NearestIndexSlow(TunnelAnchorX, TunnelAnchorZ);
		const double Per = Sp.Length / Sp.Count;
		const int32 Span = FMath::RoundToInt32(TunnelHalfLength / Per);
		Sp.MarkFlag(TunnelAnchorIndex - Span, TunnelAnchorIndex + Span, FApexTrackSpline::FLAG_TUNNEL);
	}

	/* ── 3. elevation ── */
	// road height ignores the gorge so the bridge spans it at natural ground level
	Sp.BuildElevation([](double X, double Z) { return ApexBaseHeight(X, Z, false); },
		26, 5, 0.075, 0.28);
	Sp.BuildBanking(0.085);
	Sp.BuildWidth(8.2, 7.0);

	// terrain is levelled beside the road everywhere except across the bridge
	for (int32 i = 0; i < Sp.Count; ++i)
	{
		Sp.FlattenWeight[i] = (Sp.Flags[i] & FApexTrackSpline::FLAG_BRIDGE) ? 0.0 : 1.0;
	}
	Sp.Smooth(Sp.FlattenWeight, 8, 3);
	Sp.BuildLookup(-Half, -Half, Half, Half, 24.0, 96.0);

	/* ── 4. terrain ── */
	Terrain = MakeShared<FApexTerrain>(Sp);
	Terrain->Build();

	StartIndex = FindStraightest();

	/* ── 5. geometry ── */
	TArray<FApexMeshGroup> Groups;
	TArray<FApexBoxCollider> BoxColliders;
	TArray<FApexCapsuleCollider> CapsuleColliders;

	{
		// terrain, tiled so frustum culling has something to work with
		constexpr int32 Tiles = 6;
		for (int32 Tz = 0; Tz < Tiles; ++Tz)
		{
			for (int32 Tx = 0; Tx < Tiles; ++Tx)
			{
				FApexMeshGroup& G = Groups.AddDefaulted_GetRef();
				G.Name = FString::Printf(TEXT("Terrain_%d_%d"), Tx, Tz);
				G.bCollision = true;
				G.bCastShadow = false;   // the landscape self-shadows through Lumen
				Terrain->BuildMeshTile(Tx, Tz, Tiles, G.SectionFor("terrain"));
			}
		}

		FApexMeshGroup& Water = Groups.AddDefaulted_GetRef();
		Water.Name = TEXT("Water");
		Water.bCastShadow = false;
		Terrain->BuildWater(Water.SectionFor("water"));
	}

	{
		const FApexRoadBuilder Road(Sp, *Terrain);

		FApexMeshGroup& G = Groups.AddDefaulted_GetRef();
		G.Name = TEXT("Road");
		G.bCollision = true;
		G.bCastShadow = false;
		Road.BuildRoad(G.SectionFor("road"));
		Road.BuildKerbs(G.SectionFor("kerb"));
		Road.BuildSidewalks(G.SectionFor("sidewalk"));
		Road.BuildStartLine(StartIndex, G.SectionFor("startLine"));
		G.Compact();

		FApexMeshGroup& B = Groups.AddDefaulted_GetRef();
		B.Name = TEXT("Barriers");
		TArray<FApexInstance> Posts;
		Road.BuildBarriers(B.SectionFor("concrete"), B.SectionFor("barrierMetal"), BoxColliders, Posts);

		FApexMeshData& PostMesh = B.SectionFor("metalPole");
		for (const FApexInstance& Inst : Posts)
		{
			PostMesh.AddBox(Inst.Transform.GetLocation() + FVector(0, 0, 45),
				FVector(6, 5, 45), Inst.Transform.GetRotation(), FColor(120, 124, 130));
		}
		PostMesh.ComputeNormals();
		B.Compact();
	}

	FApexPropsResult Props;
	ApexProps::BuildBridge(Sp, *Terrain, Props);
	ApexProps::BuildTunnel(Sp, Props);
	ApexProps::BuildStartGantry(Sp, StartIndex, Props);
	ApexProps::BuildCity(Sp, *Terrain, PropDensity, Props);
	ApexProps::BuildVegetation(Sp, *Terrain, PropDensity, Props);
	ApexProps::BuildStreetFurniture(Sp, *Terrain, PropDensity, Props);

	Groups.Append(MoveTemp(Props.Groups));
	BoxColliders.Append(MoveTemp(Props.BoxColliders));
	CapsuleColliders.Append(MoveTemp(Props.CapsuleColliders));
	TreeCount = Props.TreeCount;
	BuildingCount = Props.BuildingCount;

	/* ── 6. components ── */
	// Split everything onto a 300 m grid first. Several builders naturally produce one
	// mesh for a whole system — the barriers and street furniture run the entire
	// circuit — and a primitive that large is effectively unculled and, under virtual
	// shadow maps, gets re-rendered into page after page.
	{
		TArray<FApexMeshGroup> Chunked;
		Chunked.Reserve(Groups.Num() * 4);
		for (const FApexMeshGroup& Group : Groups)
		{
			ApexMesh::SplitIntoChunks(Group, 300.0 * APEX_TO_UE, Chunked);
		}
		Groups = MoveTemp(Chunked);
	}

	CreateMeshComponents(Groups);
	CreateColliders(BoxColliders, CapsuleColliders);
	CreateWorldBounds();
	CreateLights(Props.StreetLamps, Props.TunnelLights);

	/* ── 7. race furniture ── */
	BuildCheckpoints();
	BuildRacingLine();

	bBuilt = true;
	UE_LOG(LogApex, Log, TEXT("World built in %.2f s — %d m circuit, %d trees, %d buildings, %d mesh components"),
		FPlatformTime::Seconds() - StartTime, FMath::RoundToInt32(Sp.Length), TreeCount, BuildingCount,
		MeshComponents.Num());
}

void AApexWorldActor::CreateMeshComponents(TArray<FApexMeshGroup>& Groups)
{
	for (FApexMeshGroup& Group : Groups)
	{
		if (Group.IsEmpty())
		{
			continue;
		}

		for (int32 i = 0; i < Group.NumSections(); ++i)
		{
			Group.SectionAt(i).SanitiseNonFinite(
				*FString::Printf(TEXT("%s/%s"), *Group.Name, *Group.SectionMaterials[i].ToString()));
		}

		UProceduralMeshComponent* Mesh = NewObject<UProceduralMeshComponent>(this, *Group.Name);
		Mesh->SetupAttachment(RootComponent);
		// Cooked synchronously: the cars are spawned onto this collision in the same
		// frame, so async cooking would drop them through the road on the first tick.
		Mesh->bUseAsyncCooking = false;
		Mesh->bUseComplexAsSimpleCollision = true;
		Mesh->SetCastShadow(Group.bCastShadow);
		Mesh->SetMobility(EComponentMobility::Static);

		if (Group.bCollision)
		{
			Mesh->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
			Mesh->SetCollisionObjectType(ECC_WorldStatic);
			Mesh->SetCollisionResponseToAllChannels(ECR_Block);
		}
		else
		{
			Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		}

		for (int32 i = 0; i < Group.NumSections(); ++i)
		{
			Group.SectionAt(i).ToSection(Mesh, i, Group.bCollision);
			if (Materials)
			{
				Mesh->SetMaterial(i, Materials->Get(Group.SectionMaterials[i]));
			}
		}

		Mesh->RegisterComponent();
		MeshComponents.Add(Mesh);
	}
}

void AApexWorldActor::CreateColliders(const TArray<FApexBoxCollider>& Boxes,
	const TArray<FApexCapsuleCollider>& Capsules)
{
	int32 Index = 0;
	for (const FApexBoxCollider& Box : Boxes)
	{
		UBoxComponent* Comp = NewObject<UBoxComponent>(this,
			*FString::Printf(TEXT("BoxCollider_%d"), Index++));
		Comp->SetupAttachment(RootComponent);
		Comp->SetMobility(EComponentMobility::Static);
		Comp->SetBoxExtent(Box.HalfExtents, false);
		Comp->SetWorldLocationAndRotation(Box.Center, Box.Rotation);
		Comp->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
		Comp->SetCollisionObjectType(ECC_WorldStatic);
		Comp->SetCollisionResponseToAllChannels(ECR_Block);
		Comp->RegisterComponent();
	}

	Index = 0;
	for (const FApexCapsuleCollider& Cap : Capsules)
	{
		UCapsuleComponent* Comp = NewObject<UCapsuleComponent>(this,
			*FString::Printf(TEXT("TreeCollider_%d"), Index++));
		Comp->SetupAttachment(RootComponent);
		Comp->SetMobility(EComponentMobility::Static);
		Comp->SetCapsuleSize(Cap.Radius, Cap.HalfHeight, false);
		Comp->SetWorldLocation(Cap.Center);
		Comp->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
		Comp->SetCollisionObjectType(ECC_WorldStatic);
		Comp->SetCollisionResponseToAllChannels(ECR_Block);
		Comp->RegisterComponent();
	}
}

void AApexWorldActor::CreateWorldBounds()
{
	// Invisible walls at the edge of the playable area, behind the mountain ring.
	constexpr double H = (Half + 20.0) * APEX_TO_UE;
	const FVector Sizes[4][2] = {
		{ FVector(0, H, 16000), FVector(H, 400, 26000) },
		{ FVector(0, -H, 16000), FVector(H, 400, 26000) },
		{ FVector(H, 0, 16000), FVector(400, H, 26000) },
		{ FVector(-H, 0, 16000), FVector(400, H, 26000) },
	};

	for (int32 i = 0; i < 4; ++i)
	{
		UBoxComponent* Comp = NewObject<UBoxComponent>(this, *FString::Printf(TEXT("WorldBound_%d"), i));
		Comp->SetupAttachment(RootComponent);
		Comp->SetMobility(EComponentMobility::Static);
		Comp->SetBoxExtent(Sizes[i][1], false);
		Comp->SetWorldLocation(Sizes[i][0]);
		Comp->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
		Comp->SetCollisionObjectType(ECC_WorldStatic);
		Comp->SetCollisionResponseToAllChannels(ECR_Block);
		Comp->RegisterComponent();
	}
}

void AApexWorldActor::CreateLights(const TArray<FVector>& StreetLamps, const TArray<FVector>& TunnelLights)
{
	int32 Index = 0;
	for (const FVector& P : StreetLamps)
	{
		USpotLightComponent* Light = NewObject<USpotLightComponent>(this,
			*FString::Printf(TEXT("StreetLamp_%d"), Index++));
		Light->SetupAttachment(RootComponent);
		Light->SetMobility(EComponentMobility::Movable);
		Light->SetWorldLocationAndRotation(P, FRotator(-90.f, 0.f, 0.f));
		Light->SetIntensityUnits(ELightUnits::Lumens);
		Light->SetIntensity(9000.f);
		Light->SetAttenuationRadius(2600.f);
		Light->SetInnerConeAngle(28.f);
		Light->SetOuterConeAngle(62.f);
		Light->SetLightColor(FLinearColor(1.f, 0.92f, 0.76f));
		Light->SetCastShadows(false);
		Light->SetVisibility(false);
		Light->RegisterComponent();
		StreetLights.Add(Light);
	}

	Index = 0;
	for (const FVector& P : TunnelLights)
	{
		UPointLightComponent* Light = NewObject<UPointLightComponent>(this,
			*FString::Printf(TEXT("TunnelLight_%d"), Index++));
		Light->SetupAttachment(RootComponent);
		Light->SetMobility(EComponentMobility::Movable);
		Light->SetWorldLocation(P);
		Light->SetIntensityUnits(ELightUnits::Lumens);
		Light->SetIntensity(6000.f);
		Light->SetAttenuationRadius(2200.f);
		Light->SetLightColor(FLinearColor(1.f, 0.90f, 0.72f));
		Light->SetCastShadows(false);
		Light->RegisterComponent();
		TunnelLightComponents.Add(Light);
	}
}

void AApexWorldActor::SetNightLighting(bool bOn)
{
	for (USpotLightComponent* Light : StreetLights)
	{
		if (Light)
		{
			Light->SetVisibility(bOn);
		}
	}
}

int32 AApexWorldActor::FindStraightest() const
{
	// Pick the flattest, straightest stretch for the start/finish line.
	const FApexTrackSpline& Sp = *Spline;
	const int32 N = Sp.Count;
	const int32 Win = FMath::RoundToInt32(70.0 / (Sp.Length / N));

	int32 Best = 0;
	double BestScore = TNumericLimits<double>::Max();
	for (int32 i = 0; i < N; ++i)
	{
		if (Sp.Flags[i] & (FApexTrackSpline::FLAG_TUNNEL | FApexTrackSpline::FLAG_BRIDGE | FApexTrackSpline::FLAG_CITY))
		{
			continue;
		}
		double Score = 0.0;
		for (int32 K = -Win; K <= Win; ++K)
		{
			const int32 J = ((i + K) % N + N) % N;
			Score += FMath::Abs(Sp.Curvature[J]) * 1000.0 + FMath::Abs(Sp.Ty[J]) * 3.0;
		}
		if (Score < BestScore)
		{
			BestScore = Score;
			Best = i;
		}
	}
	return Best;
}

void AApexWorldActor::BuildCheckpoints()
{
	const FApexTrackSpline& Sp = *Spline;
	const double StartS = Sp.S[StartIndex];

	Checkpoints.Reset(CheckpointCount);
	for (int32 K = 0; K < CheckpointCount; ++K)
	{
		const double S = FMath::Fmod(StartS + (static_cast<double>(K) / CheckpointCount) * Sp.Length, Sp.Length);
		const FApexSplineSample Smp = Sp.SampleAt(S);

		FApexCheckpoint Cp;
		Cp.Index = K;
		Cp.S = S;
		Cp.SplineIndex = Smp.Index;
		Cp.Position = ApexToUE(Smp.X, Smp.Y, Smp.Z);
		Sp.FrameAt(Smp.Index, Cp.Right, Cp.Up, Cp.Forward);
		Cp.HalfWidth = Smp.HalfWidth + APEX_SHOULDER;
		Cp.bIsFinish = (K == 0);
		Checkpoints.Add(Cp);
	}
}

void AApexWorldActor::BuildRacingLine()
{
	const FApexTrackSpline& Sp = *Spline;
	const int32 N = Sp.Count;
	LineOffset.SetNumZeroed(N);
	LineTargetSpeed.SetNumZeroed(N);

	// out-in-out: sit wide on entry, hug the apex, drift wide on exit
	TArray<double> CurveSmooth = Sp.Curvature;
	Sp.Smooth(CurveSmooth, 8, 3);
	for (int32 i = 0; i < N; ++i)
	{
		const double K = CurveSmooth[i];
		const double Limit = FMath::Max(1.5, Sp.Width[i] - 2.6);
		LineOffset[i] = FMath::Clamp(
			-FMath::Sign(K) * SmoothStep(0.0008, 0.010, FMath::Abs(K)) * Limit, -Limit, Limit);
	}
	Sp.Smooth(LineOffset, 16, 4);

	// curvature of the offset line, then the grip-limited speed
	const double Step = Sp.Length / N;
	for (int32 i = 0; i < N; ++i)
	{
		const int32 A = (i - 6 + N) % N;
		const int32 B = (i + 6) % N;
		const double Ax = Sp.X[A] + Sp.Nx[A] * LineOffset[A], Az = Sp.Z[A] + Sp.Nz[A] * LineOffset[A];
		const double Bx = Sp.X[B] + Sp.Nx[B] * LineOffset[B], Bz = Sp.Z[B] + Sp.Nz[B] * LineOffset[B];
		const double Cx = Sp.X[i] + Sp.Nx[i] * LineOffset[i], Cz = Sp.Z[i] + Sp.Nz[i] * LineOffset[i];

		const double Radius = CircumRadius(Ax, Az, Cx, Cz, Bx, Bz);
		double V = FMath::Sqrt(APEX_REFERENCE_LAT_ACCEL * FMath::Max(Radius, 8.0));
		if (Sp.Flags[i] & FApexTrackSpline::FLAG_CITY)
		{
			V = FMath::Min(V, 58.0);
		}
		LineTargetSpeed[i] = FMath::Min(V, 95.0);
	}

	// backward pass for braking, forward pass for acceleration
	constexpr double Decel = 11.0;
	for (int32 Pass = 0; Pass < 3; ++Pass)
	{
		for (int32 K = N - 1; K >= 0; --K)
		{
			const int32 i = K, J = (i + 1) % N;
			const double Vmax = FMath::Sqrt(LineTargetSpeed[J] * LineTargetSpeed[J] + 2.0 * Decel * Step);
			LineTargetSpeed[i] = FMath::Min(LineTargetSpeed[i], Vmax);
		}
		for (int32 K = 0; K < N; ++K)
		{
			const int32 i = K, J = (i + 1) % N;
			const double Vmax = FMath::Sqrt(LineTargetSpeed[i] * LineTargetSpeed[i] + 2.0 * 7.5 * Step);
			LineTargetSpeed[J] = FMath::Min(LineTargetSpeed[J], Vmax);
		}
	}
	Sp.Smooth(LineTargetSpeed, 4, 2);
}

FApexSplineQuery AApexWorldActor::QuerySurface(double X, double Z) const
{
	FApexSplineQuery Q = Spline->Query(X, Z);
	if (Q.bFar)
	{
		Q.EdgeDistance = 60.0;
		Q.bOnRoad = false;
		Q.HalfWidth = 8.0;
		return Q;
	}
	Q.EdgeDistance = FMath::Max(0.0, Q.Dist - (Q.HalfWidth + APEX_SHOULDER * 0.6));
	Q.bOnRoad = Q.EdgeDistance <= 0.01;
	return Q;
}

FApexSplineQuery AApexWorldActor::QuerySurfaceUE(const FVector& WorldPos) const
{
	double X, Y, Z;
	UEToApex(WorldPos, X, Y, Z);
	return QuerySurface(X, Z);
}

double AApexWorldActor::GroundHeight(double X, double Z) const
{
	return Terrain->Sample(X, Z);
}

TArray<FApexPlacement> AApexWorldActor::GridSlots(int32 Count) const
{
	const FApexTrackSpline& Sp = *Spline;
	const double StartS = Sp.S[StartIndex];

	TArray<FApexPlacement> Slots;
	Slots.Reserve(Count);

	for (int32 i = 0; i < Count; ++i)
	{
		const int32 Row = i / 2;
		const int32 Col = i % 2;
		const double Back = 12.0 + Row * 9.5;
		const double S = FMath::Fmod(StartS - Back + Sp.Length * 4.0, Sp.Length);
		const FApexSplineSample Smp = Sp.SampleAt(S);

		FVector Right, Up, Fwd;
		Sp.FrameAt(Smp.Index, Right, Up, Fwd);
		const double Lateral = (Col == 0 ? 1.0 : -1.0) * (Smp.HalfWidth * 0.42);

		FApexPlacement Slot;
		Slot.Location = ApexToUE(Smp.X, Smp.Y + 0.35, Smp.Z) + Right * (Lateral * APEX_TO_UE);
		Slot.Rotation = FRotationMatrix::MakeFromXZ(Fwd, FVector::UpVector).Rotator();
		Slot.S = S;
		Slots.Add(Slot);
	}
	return Slots;
}

FApexPlacement AApexWorldActor::RespawnPoint(const FVector& WorldPos, double BackOff) const
{
	const FApexTrackSpline& Sp = *Spline;
	double X, Y, Z;
	UEToApex(WorldPos, X, Y, Z);

	const FApexSplineQuery Q = Sp.Query(X, Z);
	const double S = (Q.bFar ? Sp.S[StartIndex] : Q.S) - BackOff;
	const FApexSplineSample Smp = Sp.SampleAt(FMath::Fmod(S + Sp.Length * 2.0, Sp.Length));

	FVector Right, Up, Fwd;
	Sp.FrameAt(Smp.Index, Right, Up, Fwd);

	FApexPlacement Out;
	Out.Location = ApexToUE(Smp.X, Smp.Y + 1.2, Smp.Z);
	Out.Rotation = FRotationMatrix::MakeFromXZ(Fwd, FVector::UpVector).Rotator();
	Out.S = Smp.Index;
	return Out;
}

FVector AApexWorldActor::LinePoint(double S, double Bias) const
{
	const FApexTrackSpline& Sp = *Spline;
	const FApexSplineSample Smp = Sp.SampleAt(S);
	const double Off = LineOffset[Smp.Index] + Bias;
	const double Limit = Smp.HalfWidth - 1.4;
	const double Clamped = FMath::Clamp(Off, -Limit, Limit);
	return ApexToUE(
		Smp.X + Sp.Nx[Smp.Index] * Clamped,
		Smp.Y,
		Smp.Z + Sp.Nz[Smp.Index] * Clamped);
}

double AApexWorldActor::LineSpeedAt(double S) const
{
	const FApexTrackSpline& Sp = *Spline;
	double Ss = FMath::Fmod(S, Sp.Length);
	if (Ss < 0.0)
	{
		Ss += Sp.Length;
	}
	const int32 i = FMath::Min(Sp.Count - 1, FMath::FloorToInt32((Ss / Sp.Length) * Sp.Count));
	return LineTargetSpeed[i];
}
