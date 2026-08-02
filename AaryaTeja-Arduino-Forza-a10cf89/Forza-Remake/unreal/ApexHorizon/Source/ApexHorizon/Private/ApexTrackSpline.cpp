// Apex Horizon — centreline construction.

#include "ApexTrackSpline.h"
#include "ApexMath.h"

using namespace ApexMath;

namespace
{
	/**
	 * Closed centripetal Catmull-Rom, matching three.js CatmullRomCurve3 so the generated
	 * circuit is geometrically the same one the browser build drives.
	 */
	struct FCubicPoly
	{
		double C0 = 0, C1 = 0, C2 = 0, C3 = 0;

		void Init(double X0, double X1, double T0, double T1)
		{
			C0 = X0;
			C1 = T0;
			C2 = -3.0 * X0 + 3.0 * X1 - 2.0 * T0 - T1;
			C3 = 2.0 * X0 - 2.0 * X1 + T0 + T1;
		}

		void InitNonuniform(double X0, double X1, double X2, double X3, double Dt0, double Dt1, double Dt2)
		{
			double T1 = (X1 - X0) / Dt0 - (X2 - X0) / (Dt0 + Dt1) + (X2 - X1) / Dt1;
			double T2 = (X2 - X1) / Dt1 - (X3 - X1) / (Dt1 + Dt2) + (X3 - X2) / Dt2;
			T1 *= Dt1;
			T2 *= Dt1;
			Init(X1, X2, T1, T2);
		}

		double Calc(double T) const
		{
			const double T2 = T * T;
			return C0 + C1 * T + C2 * T2 + C3 * T2 * T;
		}
	};

	class FCentripetalCatmullRom
	{
	public:
		explicit FCentripetalCatmullRom(const TArray<FVector2D>& InPoints) : Points(InPoints) {}

		FVector2D GetPoint(double T) const
		{
			const int32 L = Points.Num();
			const double P = L * T;                 // closed curve: L segments
			int32 IntPoint = FMath::FloorToInt32(P);
			double Weight = P - IntPoint;
			if (IntPoint < 0)
			{
				IntPoint += (FMath::FloorToInt32(FMath::Abs(static_cast<double>(IntPoint)) / L) + 1) * L;
			}

			const FVector2D& P0 = Points[((IntPoint - 1) % L + L) % L];
			const FVector2D& P1 = Points[IntPoint % L];
			const FVector2D& P2 = Points[(IntPoint + 1) % L];
			const FVector2D& P3 = Points[(IntPoint + 2) % L];

			// centripetal parameterisation: alpha = 0.5, applied to squared distance
			constexpr double Pow = 0.25;
			double Dt0 = FMath::Pow(FVector2D::DistSquared(P0, P1), Pow);
			double Dt1 = FMath::Pow(FVector2D::DistSquared(P1, P2), Pow);
			double Dt2 = FMath::Pow(FVector2D::DistSquared(P2, P3), Pow);
			if (Dt1 < 1e-4) { Dt1 = 1.0; }
			if (Dt0 < 1e-4) { Dt0 = Dt1; }
			if (Dt2 < 1e-4) { Dt2 = Dt1; }

			FCubicPoly Px, Pz;
			Px.InitNonuniform(P0.X, P1.X, P2.X, P3.X, Dt0, Dt1, Dt2);
			Pz.InitNonuniform(P0.Y, P1.Y, P2.Y, P3.Y, Dt0, Dt1, Dt2);
			return FVector2D(Px.Calc(Weight), Pz.Calc(Weight));
		}

		/** Cumulative chord lengths over `Divisions` uniform-in-t samples. */
		void BuildLengths(int32 Divisions = 200)
		{
			Lengths.Reset(Divisions + 1);
			Lengths.Add(0.0);
			FVector2D Last = GetPoint(0.0);
			double Sum = 0.0;
			for (int32 i = 1; i <= Divisions; ++i)
			{
				const FVector2D Current = GetPoint(static_cast<double>(i) / Divisions);
				Sum += FVector2D::Distance(Current, Last);
				Lengths.Add(Sum);
				Last = Current;
			}
		}

		double GetLength() const { return Lengths.Num() ? Lengths.Last() : 0.0; }

		/** Arc-length fraction u to curve parameter t. */
		double UToT(double U) const
		{
			const int32 N = Lengths.Num();
			const double TargetDistance = U * Lengths[N - 1];

			int32 Low = 0, High = N - 1, i = 0;
			while (Low <= High)
			{
				i = Low + (High - Low) / 2;
				const double Diff = Lengths[i] - TargetDistance;
				if (Diff < 0.0) { Low = i + 1; }
				else if (Diff > 0.0) { High = i - 1; }
				else { High = i; break; }
			}
			i = High;
			if (i < 0) { i = 0; }
			if (i >= N - 1) { return 1.0; }
			if (Lengths[i] == TargetDistance)
			{
				return static_cast<double>(i) / (N - 1);
			}

			const double LengthBefore = Lengths[i];
			const double LengthAfter = Lengths[i + 1];
			const double SegmentLength = LengthAfter - LengthBefore;
			const double SegmentFraction = SegmentLength > 0.0 ? (TargetDistance - LengthBefore) / SegmentLength : 0.0;
			return (i + SegmentFraction) / (N - 1);
		}

	private:
		const TArray<FVector2D>& Points;
		TArray<double> Lengths;
	};
}

FApexTrackSpline::FApexTrackSpline(const TArray<FVector2D>& ControlPoints, double Spacing)
{
	FCentripetalCatmullRom Curve(ControlPoints);
	Curve.BuildLengths(200);

	const double ApproxLen = Curve.GetLength();
	Count = FMath::Max(256, FMath::RoundToInt32(ApproxLen / Spacing));

	X.SetNumZeroed(Count); Y.SetNumZeroed(Count); Z.SetNumZeroed(Count);
	Tx.SetNumZeroed(Count); Ty.SetNumZeroed(Count); Tz.SetNumZeroed(Count);
	Nx.SetNumZeroed(Count); Nz.SetNumZeroed(Count);
	Curvature.SetNumZeroed(Count);
	Bank.SetNumZeroed(Count);
	S.SetNumZeroed(Count);
	Width.SetNumZeroed(Count);
	Flags.SetNumZeroed(Count);
	FlattenWeight.SetNumZeroed(Count);

	// Equally spaced in arc length; on a closed curve the wrap point duplicates sample 0,
	// so only the first `Count` are taken.
	for (int32 i = 0; i < Count; ++i)
	{
		const double U = static_cast<double>(i) / Count;
		const FVector2D P = Curve.GetPoint(Curve.UToT(U));
		X[i] = P.X;
		Z[i] = P.Y;
	}

	ComputeArcLength();
	ComputeFrames();

	for (int32 i = 0; i < Count; ++i)
	{
		Width[i] = 8.0;
	}
}

void FApexTrackSpline::ComputeArcLength()
{
	double Acc = 0.0;
	for (int32 i = 0; i < Count; ++i)
	{
		S[i] = Acc;
		const int32 J = (i + 1) % Count;
		Acc += FMath::Sqrt(FMath::Square(X[J] - X[i]) + FMath::Square(Z[J] - Z[i]));
	}
	Length = Acc;
}

void FApexTrackSpline::ComputeFrames()
{
	for (int32 i = 0; i < Count; ++i)
	{
		const int32 A = (i - 1 + Count) % Count;
		const int32 B = (i + 1) % Count;
		double Dx = X[B] - X[A];
		double Dz = Z[B] - Z[A];
		const double L = FMath::Max(FMath::Sqrt(Dx * Dx + Dz * Dz), 1e-9);
		Dx /= L; Dz /= L;
		Tx[i] = Dx; Tz[i] = Dz;
		// lateral normal, consistently one side of travel
		Nx[i] = Dz; Nz[i] = -Dx;
	}

	// signed curvature from the turn rate of the tangent per metre
	for (int32 i = 0; i < Count; ++i)
	{
		const int32 A = (i - 2 + Count) % Count;
		const int32 B = (i + 2) % Count;
		const double Cross = Tx[A] * Tz[B] - Tz[A] * Tx[B];
		const double Dot = FMath::Clamp(Tx[A] * Tx[B] + Tz[A] * Tz[B], -1.0, 1.0);
		const double Ang = FMath::Atan2(Cross, Dot);
		const double Ds = FMath::Max(ArcBetween(A, B), 1e-6);
		Curvature[i] = -Ang / Ds;
	}
	Smooth(Curvature, 3, 2);
}

double FApexTrackSpline::ArcBetween(int32 A, int32 B) const
{
	double D = S[B] - S[A];
	if (D < 0.0) { D += Length; }
	if (D > Length * 0.5) { D = Length - D; }
	return FMath::Abs(D);
}

void FApexTrackSpline::Smooth(TArray<double>& Arr, int32 Radius, int32 Passes) const
{
	const int32 N = Arr.Num();
	if (N == 0 || Radius <= 0)
	{
		return;
	}
	TArray<double> Tmp;
	Tmp.SetNumUninitialized(N);
	for (int32 P = 0; P < Passes; ++P)
	{
		for (int32 i = 0; i < N; ++i)
		{
			double Sum = 0.0;
			int32 Cnt = 0;
			for (int32 K = -Radius; K <= Radius; ++K)
			{
				Sum += Arr[((i + K) % N + N) % N];
				++Cnt;
			}
			Tmp[i] = Sum / Cnt;
		}
		Arr = Tmp;
	}
}

void FApexTrackSpline::BuildElevation(TFunctionRef<double(double, double)> BaseHeightFn,
	int32 SmoothRadius, int32 Passes, double MaxGrade, double Lift)
{
	for (int32 i = 0; i < Count; ++i)
	{
		Y[i] = BaseHeightFn(X[i], Z[i]);
	}
	Smooth(Y, SmoothRadius, Passes);

	// enforce a maximum gradient with a few relaxation sweeps (forward then backward)
	const double Step = Length / Count;
	for (int32 Pass = 0; Pass < 24; ++Pass)
	{
		int32 Changed = 0;
		for (int32 Dir = 0; Dir < 2; ++Dir)
		{
			for (int32 K = 0; K < Count; ++K)
			{
				const int32 i = Dir == 0 ? K : Count - 1 - K;
				const int32 J = (i + 1) % Count;
				const double Dy = Y[J] - Y[i];
				const double MaxDy = MaxGrade * Step;
				if (FMath::Abs(Dy) > MaxDy)
				{
					const double Excess = (FMath::Abs(Dy) - MaxDy) * 0.5 * FMath::Sign(Dy);
					Y[i] += Excess;
					Y[J] -= Excess;
					++Changed;
				}
			}
		}
		if (Changed == 0)
		{
			break;
		}
	}
	Smooth(Y, 6, 2);

	if (Lift != 0.0)
	{
		for (int32 i = 0; i < Count; ++i)
		{
			Y[i] += Lift;
		}
	}

	// vertical tangent component for road pitch
	for (int32 i = 0; i < Count; ++i)
	{
		const int32 A = (i - 1 + Count) % Count;
		const int32 B = (i + 1) % Count;
		const double Ds = FMath::Max(ArcBetween(A, B), 1e-6);
		Ty[i] = (Y[B] - Y[A]) / Ds;
	}
}

void FApexTrackSpline::BuildBanking(double MaxBankRad)
{
	for (int32 i = 0; i < Count; ++i)
	{
		Bank[i] = FMath::Clamp(Curvature[i] * 260.0, -1.0, 1.0) * MaxBankRad;
	}
	Smooth(Bank, 14, 3);
}

void FApexTrackSpline::BuildWidth(double Base, double CityHalf)
{
	for (int32 i = 0; i < Count; ++i)
	{
		const bool bInCity = (Flags[i] & FLAG_CITY) != 0;
		const double K = FMath::Abs(Curvature[i]);
		double W = Base + SmoothStep(0.006, 0.0, K) * 1.4;
		if (bInCity)
		{
			W = FMath::Min(W, CityHalf);
		}
		if (Flags[i] & FLAG_TUNNEL)
		{
			W = FMath::Min(W, Base);
		}
		Width[i] = W;
	}
	Smooth(Width, 16, 3);
}

void FApexTrackSpline::MarkFlag(int32 StartIdx, int32 EndIdx, uint8 Flag)
{
	int32 i = ((StartIdx % Count) + Count) % Count;
	const int32 End = ((EndIdx % Count) + Count) % Count;
	for (int32 C = 0; C < Count + 2; ++C)
	{
		Flags[i] |= Flag;
		if (i == End)
		{
			break;
		}
		i = (i + 1) % Count;
	}
}

int32 FApexTrackSpline::NearestIndexSlow(double InX, double InZ) const
{
	int32 Best = 0;
	double BestD = TNumericLimits<double>::Max();
	for (int32 i = 0; i < Count; ++i)
	{
		const double D = FMath::Square(X[i] - InX) + FMath::Square(Z[i] - InZ);
		if (D < BestD)
		{
			BestD = D;
			Best = i;
		}
	}
	return Best;
}

void FApexTrackSpline::BuildLookup(double MinX, double MinZ, double MaxX, double MaxZ, double Cell, double SearchRadius)
{
	LuMinX = MinX; LuMinZ = MinZ; LuCell = Cell; LuSearchRadius = SearchRadius;
	LuCols = FMath::CeilToInt32((MaxX - MinX) / Cell) + 1;
	LuRows = FMath::CeilToInt32((MaxZ - MinZ) / Cell) + 1;
	LuBuckets.Reset();
	LuBuckets.SetNum(LuCols * LuRows);

	const int32 R = FMath::CeilToInt32(SearchRadius / Cell);
	for (int32 i = 0; i < Count; ++i)
	{
		const int32 Cx = FMath::FloorToInt32((X[i] - MinX) / Cell);
		const int32 Cz = FMath::FloorToInt32((Z[i] - MinZ) / Cell);
		for (int32 A = -R; A <= R; ++A)
		{
			for (int32 B = -R; B <= R; ++B)
			{
				const int32 Gx = Cx + A, Gz = Cz + B;
				if (Gx < 0 || Gz < 0 || Gx >= LuCols || Gz >= LuRows)
				{
					continue;
				}
				LuBuckets[Gz * LuCols + Gx].Add(i);
			}
		}
	}
	bHasLookup = true;
}

FApexSplineQuery FApexTrackSpline::Query(double InX, double InZ) const
{
	FApexSplineQuery Out;

	int32 Best = -1;
	double BestD2 = TNumericLimits<double>::Max();
	if (bHasLookup)
	{
		const int32 Gx = FMath::FloorToInt32((InX - LuMinX) / LuCell);
		const int32 Gz = FMath::FloorToInt32((InZ - LuMinZ) / LuCell);
		if (Gx >= 0 && Gz >= 0 && Gx < LuCols && Gz < LuRows)
		{
			for (int32 i : LuBuckets[Gz * LuCols + Gx])
			{
				const double D2 = FMath::Square(X[i] - InX) + FMath::Square(Z[i] - InZ);
				if (D2 < BestD2)
				{
					BestD2 = D2;
					Best = i;
				}
			}
		}
	}

	if (Best < 0)
	{
		Out.bFar = true;
		Out.Index = -1;
		Out.Dist = bHasLookup ? LuSearchRadius : 1e5;
		Out.SignedDist = Out.Dist;
		Out.HalfWidth = 8.0;
		Out.EdgeDistance = 60.0;
		return Out;
	}

	// refine to the exact perpendicular foot on the two adjacent segments
	const int32 Prev = (Best - 1 + Count) % Count;
	const int32 Next = (Best + 1) % Count;
	const int32 Cand[2][2] = { { Prev, Best }, { Best, Next } };

	double Bt = 0.0, Bd2 = TNumericLimits<double>::Max();
	int32 Bi = Best;
	for (const int32(&Pair)[2] : Cand)
	{
		const int32 A = Pair[0], B = Pair[1];
		const double Ax = X[A], Az = Z[A];
		const double Abx = X[B] - Ax, Abz = Z[B] - Az;
		const double Len2 = FMath::Max(Abx * Abx + Abz * Abz, 1e-6);
		const double T = Clamp01(((InX - Ax) * Abx + (InZ - Az) * Abz) / Len2);
		const double Px = Ax + Abx * T, Pz = Az + Abz * T;
		const double D2 = FMath::Square(Px - InX) + FMath::Square(Pz - InZ);
		if (D2 < Bd2)
		{
			Bd2 = D2;
			Bt = T;
			Bi = A;
		}
	}

	const int32 J = (Bi + 1) % Count;
	const double Dist = FMath::Sqrt(Bd2);
	const double Cx = Lerp(X[Bi], X[J], Bt);
	const double Cz = Lerp(Z[Bi], Z[J], Bt);
	const double Side = (InX - Cx) * Nx[Bi] + (InZ - Cz) * Nz[Bi];

	double SVal = S[Bi] + Bt * FMath::Fmod((S[J] - S[Bi]) + Length, Length);
	if (SVal >= Length)
	{
		SVal -= Length;
	}

	Out.Index = Bi;
	Out.T = Bt;
	Out.Dist = Dist;
	Out.SignedDist = Side >= 0.0 ? Dist : -Dist;
	Out.Y = Lerp(Y[Bi], Y[J], Bt);
	Out.S = SVal;
	Out.HalfWidth = Lerp(Width[Bi], Width[J], Bt);
	Out.bOnRoad = Dist <= Out.HalfWidth;
	return Out;
}

FApexSplineSample FApexTrackSpline::SampleAt(double InS) const
{
	FApexSplineSample Out;

	double Ss = FMath::Fmod(InS, Length);
	if (Ss < 0.0)
	{
		Ss += Length;
	}

	int32 i = FMath::Clamp(FMath::FloorToInt32((Ss / Length) * Count), 0, Count - 1) % Count;
	// samples are equidistant in projected XZ, so s is not perfectly uniform — nudge
	for (int32 Guard = 0; Guard < 8; ++Guard)
	{
		const int32 J = (i + 1) % Count;
		const double Sa = S[i];
		double Sb = S[J];
		if (Sb <= Sa) { Sb += Length; }
		if (Ss < Sa) { i = (i - 1 + Count) % Count; continue; }
		if (Ss > Sb) { i = (i + 1) % Count; continue; }
		break;
	}

	const int32 J = (i + 1) % Count;
	const double Sa = S[i];
	double Sb = S[J];
	if (Sb <= Sa) { Sb += Length; }
	const double T = Clamp01((Ss - Sa) / FMath::Max(Sb - Sa, 1e-9));

	Out.Index = i;
	Out.T = T;
	Out.X = Lerp(X[i], X[J], T);
	Out.Z = Lerp(Z[i], Z[J], T);
	Out.Y = Lerp(Y[i], Y[J], T);
	Out.Tx = Tx[i]; Out.Tz = Tz[i]; Out.Ty = Ty[i];
	Out.Nx = Nx[i]; Out.Nz = Nz[i];
	Out.Curvature = Lerp(Curvature[i], Curvature[J], T);
	Out.HalfWidth = Lerp(Width[i], Width[J], T);
	Out.Bank = Lerp(Bank[i], Bank[J], T);
	Out.Flags = Flags[i];
	return Out;
}

double FApexTrackSpline::ForwardArc(double Sa, double Sb) const
{
	double D = Sb - Sa;
	while (D < 0.0) { D += Length; }
	while (D >= Length) { D -= Length; }
	return D;
}

double FApexTrackSpline::SignedArc(double Sa, double Sb) const
{
	double D = ForwardArc(Sa, Sb);
	if (D > Length * 0.5)
	{
		D -= Length;
	}
	return D;
}

void FApexTrackSpline::FrameAt(int32 Index, FVector& OutRight, FVector& OutUp, FVector& OutFwd) const
{
	const int32 i = ((Index % Count) + Count) % Count;

	// Build the frame in Apex space (Y up), then hand back Unreal-space directions.
	FVector Fwd = FVector(Tx[i], Ty[i], Tz[i]);   // (x, y-up, z) in Apex terms
	Fwd.Normalize();
	FVector Right = FVector(Nx[i], 0.0, Nz[i]);
	Right.Normalize();
	// Apex-space cross product with Y as the vertical axis
	FVector Up = FVector(
		Right.Y * Fwd.Z - Right.Z * Fwd.Y,
		Right.Z * Fwd.X - Right.X * Fwd.Z,
		Right.X * Fwd.Y - Right.Y * Fwd.X);
	Up.Normalize();
	if (Up.Y < 0.0)
	{
		Up = -Up;
	}

	const double B = Bank[i];
	if (B != 0.0)
	{
		Right = Right.RotateAngleAxisRad(B, Fwd);
		Up = Up.RotateAngleAxisRad(B, Fwd);
	}

	OutFwd = ApexDirToUE(Fwd.X, Fwd.Y, Fwd.Z);
	OutRight = ApexDirToUE(Right.X, Right.Y, Right.Z);
	OutUp = ApexDirToUE(Up.X, Up.Y, Up.Z);
}
