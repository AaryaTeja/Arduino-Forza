// Apex Horizon — road surface construction.

#include "ApexRoadBuilder.h"
#include "Algo/Reverse.h"
#include "ApexMath.h"
#include "ApexTerrain.h"
#include "ApexTrackSpline.h"

using namespace ApexMath;

namespace
{
	constexpr double CROWN = 0.055;
	constexpr double SHOULDER_DROP = 0.14;
}

FApexRoadBuilder::FApexRoadBuilder(const FApexTrackSpline& InSpline, const FApexTerrain& InTerrain)
	: Spline(InSpline)
	, Terrain(InTerrain)
{
}

void FApexRoadBuilder::BuildRoad(FApexMeshData& Out) const
{
	TArray<int32> All;
	All.Reserve(Spline.Count);
	for (int32 i = 0; i < Spline.Count; ++i)
	{
		All.Add(i);
	}

	// Full cross-section, normalised so u = 0..1 spans tarmac + both shoulders.
	auto Profile = [this](int32 i, int32 /*Row*/, TArray<FApexProfilePoint>& Pts)
	{
		const double Hw = Spline.Width[i];
		const double Total = Hw + APEX_SHOULDER;
		const double Xs[] = { -Total, -Hw, -Hw * 0.5, 0.0, Hw * 0.5, Hw, Total };

		Pts.Reset(UE_ARRAY_COUNT(Xs));
		for (double X : Xs)
		{
			const double A = FMath::Abs(X);
			const double Y = (A <= Hw)
				? CROWN * (1.0 - FMath::Square(A / Hw))
				: -SHOULDER_DROP * SmoothStep(Hw, Total, A);
			Pts.Add({ X, Y, (X + Total) / (2.0 * Total) });
		}
	};

	ApexMesh::BuildRibbon(Spline, All, Profile, Out, 1.0 / 24.0, /*bClosed*/ true);
	Out.ComputeNormals();
}

void FApexRoadBuilder::BuildKerbs(FApexMeshData& Out) const
{
	const TArray<TArray<int32>> Runs = ApexMesh::FindRuns(Spline,
		[this](int32 i)
		{
			return FMath::Abs(Spline.Curvature[i]) > 0.0042
				&& !(Spline.Flags[i] & FApexTrackSpline::FLAG_BRIDGE);
		}, 6, 3);

	for (const TArray<int32>& Run : Runs)
	{
		double SignSum = 0.0;
		for (int32 i : Run)
		{
			SignSum += FMath::Sign(Spline.Curvature[i]);
		}
		const double Side = SignSum >= 0.0 ? 1.0 : -1.0;   // apex side
		const int32 RunLen = Run.Num();

		auto Profile = [this, Side, RunLen](int32 i, int32 Row, TArray<FApexProfilePoint>& Pts)
		{
			const double Hw = Spline.Width[i];
			const double T = ApexMesh::RunTaper(RunLen, Row);
			const double H = 0.02 + 0.085 * T;
			const double W = 1.3 * T;
			const double Inner = Hw * Side;
			const double Outer = (Hw + W) * Side;

			Pts.Reset(4);
			Pts.Add({ Inner, 0.005, 0.0 });
			Pts.Add({ Lerp(Inner, Outer, 0.35), H, 0.35 });
			Pts.Add({ Outer, H * 0.82, 1.0 });
			Pts.Add({ Outer + 0.22 * Side, -0.06, 1.06 });
			if (Side < 0.0)
			{
				Algo::Reverse(Pts);
			}
		};

		ApexMesh::BuildRibbon(Spline, Run, Profile, Out, 1.0 / 2.4);
	}

	Out.ComputeNormals();
}

void FApexRoadBuilder::BuildSidewalks(FApexMeshData& Out) const
{
	const TArray<TArray<int32>> Runs = ApexMesh::FindRuns(Spline,
		[this](int32 i) { return (Spline.Flags[i] & FApexTrackSpline::FLAG_CITY) != 0; }, 8, 0);

	for (const TArray<int32>& Run : Runs)
	{
		const int32 RunLen = Run.Num();
		for (double Side : { 1.0, -1.0 })
		{
			auto Profile = [this, Side, RunLen](int32 i, int32 Row, TArray<FApexProfilePoint>& Pts)
			{
				const double Hw = Spline.Width[i] + APEX_SHOULDER;
				const double T = ApexMesh::RunTaper(RunLen, Row);
				const double H = 0.155 * T;
				const double Inner = Hw * Side;
				const double Outer = (Hw + 3.4) * Side;

				Pts.Reset(4);
				Pts.Add({ Inner, -SHOULDER_DROP + 0.01, 0.0 });
				Pts.Add({ Inner + 0.10 * Side, H, 0.05 });
				Pts.Add({ Outer, H + 0.02, 1.6 });
				Pts.Add({ Outer + 0.4 * Side, -0.3, 1.8 });
				if (Side < 0.0)
				{
					Algo::Reverse(Pts);
				}
			};

			ApexMesh::BuildRibbon(Spline, Run, Profile, Out, 1.0 / 6.0);
		}
	}

	Out.ComputeNormals();
}

void FApexRoadBuilder::BuildBarriers(FApexMeshData& OutConcrete, FApexMeshData& OutMetal,
	TArray<FApexBoxCollider>& OutColliders, TArray<FApexInstance>& OutPosts) const
{
	// 0 = none, 1 = concrete, 2 = metal
	auto Needs = [this](int32 i, double Side) -> int32
	{
		if (Spline.Flags[i] & FApexTrackSpline::FLAG_BRIDGE)
		{
			return 1;
		}
		if (Spline.Flags[i] & FApexTrackSpline::FLAG_TUNNEL)
		{
			return 0;
		}
		const double Off = Spline.Width[i] + APEX_SHOULDER + 6.0;
		// Offset in the spline's own lateral direction, evaluated in Apex space.
		const double Px = Spline.X[i] + Spline.Nx[i] * Off * Side;
		const double Pz = Spline.Z[i] + Spline.Nz[i] * Off * Side;
		const double Drop = Spline.Y[i] - Terrain.Sample(Px, Pz);
		return Drop > 2.6 ? 2 : 0;
	};

	FVector Right, Up, Fwd;

	for (double Side : { 1.0, -1.0 })
	{
		for (int32 Kind : { 1, 2 })
		{
			const TArray<TArray<int32>> Runs = ApexMesh::FindRuns(Spline,
				[&Needs, Side, Kind](int32 i) { return Needs(i, Side) == Kind; }, 5, 2);

			for (const TArray<int32>& Run : Runs)
			{
				const bool bConcrete = Kind == 1;
				const double TopY = bConcrete ? 1.05 : 0.86;
				const double BotY = bConcrete ? -0.15 : 0.42;
				const double Thick = bConcrete ? 0.34 : 0.09;
				const int32 RunLen = Run.Num();

				auto Profile = [this, Side, RunLen, TopY, BotY, Thick](int32 i, int32 Row, TArray<FApexProfilePoint>& Pts)
				{
					const double T = ApexMesh::RunTaper(RunLen, Row);
					const double Off = (Spline.Width[i] + APEX_SHOULDER * 0.75) * Side;
					const double Hi = Lerp(BotY, TopY, T);

					Pts.Reset(4);
					Pts.Add({ Off, BotY, 0.0 });
					Pts.Add({ Off, Hi, 1.0 });
					Pts.Add({ Off + Thick * Side, Hi, 1.1 });
					Pts.Add({ Off + Thick * Side, BotY, 0.1 });
					if (Side < 0.0)
					{
						Algo::Reverse(Pts);
					}
				};

				ApexMesh::BuildRibbon(Spline, Run, Profile, bConcrete ? OutConcrete : OutMetal, 1.0 / 4.0);

				// physics boxes every few samples
				const double PerSample = Spline.Length / Spline.Count;
				const int32 Stride = FMath::Max(2, FMath::RoundToInt32(6.0 / PerSample));
				for (int32 K = 0; K + 1 < RunLen; K += Stride)
				{
					const int32 A = Run[K];
					const int32 B = Run[FMath::Min(K + Stride, RunLen - 1)];
					if (A == B)
					{
						continue;
					}

					Spline.FrameAt(A, Right, Up, Fwd);
					const double OffA = (Spline.Width[A] + APEX_SHOULDER * 0.75 + Thick * 0.5) * Side;
					const FVector PA = ApexToUE(Spline.X[A], Spline.Y[A], Spline.Z[A]) + Right * (OffA * APEX_TO_UE);

					Spline.FrameAt(B, Right, Up, Fwd);
					const double OffB = (Spline.Width[B] + APEX_SHOULDER * 0.75 + Thick * 0.5) * Side;
					const FVector PB = ApexToUE(Spline.X[B], Spline.Y[B], Spline.Z[B]) + Right * (OffB * APEX_TO_UE);

					const FVector Mid = (PA + PB) * 0.5 + FVector(0, 0, (TopY + BotY) * 0.5 * APEX_TO_UE);
					const FVector Along = PB - PA;
					const double HalfLen = Along.Size2D() * 0.5 + 0.35 * APEX_TO_UE;

					FApexBoxCollider Box;
					Box.Center = Mid;
					// local X spans the barrier length, local Y its thickness
					Box.HalfExtents = FVector(
						HalfLen,
						Thick * 0.6 * APEX_TO_UE,
						((TopY - BotY) * 0.5 + 0.1) * APEX_TO_UE);
					Box.Rotation = FRotationMatrix::MakeFromXZ(Along.GetSafeNormal(), FVector::UpVector).ToQuat();
					Box.Friction = bConcrete ? 0.55f : 0.35f;
					Box.Restitution = bConcrete ? 0.08f : 0.18f;
					OutColliders.Add(Box);
				}

				// Armco posts
				if (!bConcrete)
				{
					const double PerSampleLen = Spline.Length / Spline.Count;
					const int32 Step = FMath::Max(2, FMath::RoundToInt32(4.0 / PerSampleLen));
					for (int32 K = 0; K < RunLen; K += Step)
					{
						const int32 i = Run[K];
						Spline.FrameAt(i, Right, Up, Fwd);
						const double Off = (Spline.Width[i] + APEX_SHOULDER * 0.75) * Side;
						const FVector Pos = ApexToUE(Spline.X[i], Spline.Y[i] + 0.1, Spline.Z[i])
							+ Right * (Off * APEX_TO_UE);

						FApexInstance Inst;
						Inst.Transform = FTransform(
							FRotationMatrix::MakeFromXZ(FVector(Fwd.X, Fwd.Y, 0.0).GetSafeNormal(), FVector::UpVector).ToQuat(),
							Pos);
						OutPosts.Add(Inst);
					}
				}
			}
		}
	}

	OutConcrete.ComputeNormals();
	OutMetal.ComputeNormals();
}

void FApexRoadBuilder::BuildStartLine(int32 StartIndex, FApexMeshData& Out) const
{
	const int32 N = Spline.Count;
	const int32 Span = FMath::Max(2, FMath::RoundToInt32(1.6 / (Spline.Length / N)));

	TArray<int32> Run;
	Run.Reserve(Span * 2 + 1);
	for (int32 K = -Span; K <= Span; ++K)
	{
		Run.Add(((StartIndex + K) % N + N) % N);
	}

	auto Profile = [this](int32 i, int32 /*Row*/, TArray<FApexProfilePoint>& Pts)
	{
		const double Hw = Spline.Width[i];
		Pts.Reset(3);
		Pts.Add({ -Hw, 0.012, 0.0 });
		Pts.Add({ 0.0, 0.012 + CROWN, 0.5 });
		Pts.Add({ Hw, 0.012, 1.0 });
	};

	ApexMesh::BuildRibbon(Spline, Run, Profile, Out, 1.0 / 3.2);
	Out.ComputeNormals();
}
