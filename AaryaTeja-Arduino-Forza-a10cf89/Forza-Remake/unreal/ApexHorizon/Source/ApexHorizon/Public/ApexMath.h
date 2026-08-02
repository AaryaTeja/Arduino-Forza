// Apex Horizon — shared math, deterministic noise and the world-space convention.
//
// The original browser build works in metres in a right-handed, Y-up space. All the
// world-generation maths below is a straight port of that, so it keeps those units and
// that axis convention; `ApexToUE` is the single place where it becomes Unreal's
// left-handed, Z-up centimetres. Swapping the two horizontal-vs-vertical axes is what
// converts the handedness, so the generated world renders identically to the original.

#pragma once

#include "CoreMinimal.h"

/** Metres (Apex space) to centimetres (Unreal space). */
static constexpr double APEX_TO_UE = 100.0;

namespace ApexMath
{
	FORCEINLINE double Clamp01(double V) { return V < 0.0 ? 0.0 : (V > 1.0 ? 1.0 : V); }
	FORCEINLINE double Lerp(double A, double B, double T) { return A + (B - A) * T; }

	/** Hermite smoothstep between two edges; matches the GLSL/three.js form. */
	FORCEINLINE double SmoothStep(double Edge0, double Edge1, double X)
	{
		const double Denom = (Edge1 - Edge0) != 0.0 ? (Edge1 - Edge0) : 1e-9;
		const double T = Clamp01((X - Edge0) / Denom);
		return T * T * (3.0 - 2.0 * T);
	}

	/** Frame-rate independent exponential approach; `Rate` = fraction of the gap closed per second. */
	FORCEINLINE double Damp(double Current, double Target, double Rate, double Dt)
	{
		return Lerp(Current, Target, 1.0 - FMath::Exp(-Rate * Dt));
	}

	/**
	 * Pow with the base clamped to zero.
	 *
	 * Unreal's PI is a float constant, so `Sin(T * PI)` at T = 1 lands just below zero
	 * (about -8.7e-8) rather than at it. Raising that to a fractional power is NaN,
	 * which then propagates into vertex positions and corrupts collision cooking.
	 */
	FORCEINLINE double PowSafe(double Base, double Exponent)
	{
		return FMath::Pow(FMath::Max(Base, 0.0), Exponent);
	}

	/** Deterministic 32-bit PRNG (mulberry32) so world generation is reproducible. */
	struct FRng
	{
		uint32 State;

		explicit FRng(uint32 Seed = 1u) : State(Seed) {}

		double operator()()
		{
			State += 0x6d2b79f5u;
			uint32 T = State;
			T = (T ^ (T >> 15)) * (T | 1u);
			T ^= T + (T ^ (T >> 7)) * (T | 61u);
			return static_cast<double>((T ^ (T >> 14))) / 4294967296.0;
		}

		/** Uniform in [Min, Max). */
		double Range(double Min, double Max) { return Min + (Max - Min) * (*this)(); }

		int32 RangeInt(int32 MinInclusive, int32 MaxExclusive)
		{
			const int32 Span = FMath::Max(1, MaxExclusive - MinInclusive);
			return MinInclusive + FMath::Min(Span - 1, static_cast<int32>((*this)() * Span));
		}
	};

	/** Cheap deterministic value hash; kept in double so it tracks the JS original. */
	FORCEINLINE double Hash2(double X, double Y)
	{
		const double H = FMath::Sin(X * 127.1 + Y * 311.7) * 43758.5453123;
		return H - FMath::Floor(H);
	}

	FORCEINLINE double ValueNoise2(double X, double Y)
	{
		const double Xi = FMath::Floor(X);
		const double Yi = FMath::Floor(Y);
		const double Xf = X - Xi;
		const double Yf = Y - Yi;
		const double U = Xf * Xf * (3.0 - 2.0 * Xf);
		const double V = Yf * Yf * (3.0 - 2.0 * Yf);
		const double A = Hash2(Xi, Yi);
		const double B = Hash2(Xi + 1.0, Yi);
		const double C = Hash2(Xi, Yi + 1.0);
		const double D = Hash2(Xi + 1.0, Yi + 1.0);
		return Lerp(Lerp(A, B, U), Lerp(C, D, U), V) * 2.0 - 1.0;
	}

	/** Fractional Brownian motion over the value noise above. */
	FORCEINLINE double Fbm2(double X, double Y, int32 Octaves = 4, double Lacunarity = 2.03, double Gain = 0.5)
	{
		double Amp = 1.0, Freq = 1.0, Sum = 0.0, Norm = 0.0;
		for (int32 i = 0; i < Octaves; ++i)
		{
			Sum += Amp * ValueNoise2(X * Freq, Y * Freq);
			Norm += Amp;
			Amp *= Gain;
			Freq *= Lacunarity;
		}
		return Norm > 0.0 ? Sum / Norm : 0.0;
	}

	/** Squared distance from point P to segment AB, plus the clamped projection parameter. */
	FORCEINLINE void SegDist2(double Px, double Pz, double Ax, double Az, double Bx, double Bz,
		double& OutD2, double& OutT)
	{
		const double Abx = Bx - Ax, Abz = Bz - Az;
		const double Apx = Px - Ax, Apz = Pz - Az;
		const double Len2 = Abx * Abx + Abz * Abz;
		double T = Len2 > 1e-9 ? (Apx * Abx + Apz * Abz) / Len2 : 0.0;
		T = Clamp01(T);
		const double Dx = Apx - Abx * T, Dz = Apz - Abz * T;
		OutD2 = Dx * Dx + Dz * Dz;
		OutT = T;
	}

	/** Radius of the circle through three points; huge when they are collinear. */
	FORCEINLINE double CircumRadius(double Ax, double Az, double Bx, double Bz, double Cx, double Cz)
	{
		const double A = FMath::Sqrt(FMath::Square(Bx - Ax) + FMath::Square(Bz - Az));
		const double B = FMath::Sqrt(FMath::Square(Cx - Bx) + FMath::Square(Cz - Bz));
		const double C = FMath::Sqrt(FMath::Square(Cx - Ax) + FMath::Square(Cz - Az));
		const double Area = FMath::Abs((Bx - Ax) * (Cz - Az) - (Cx - Ax) * (Bz - Az)) * 0.5;
		if (Area < 1e-6)
		{
			return 1e6;
		}
		return (A * B * C) / (4.0 * Area);
	}

	/** Apex space (metres, Y-up, right-handed) to Unreal space (centimetres, Z-up, left-handed). */
	FORCEINLINE FVector ApexToUE(double X, double Y, double Z)
	{
		return FVector(X * APEX_TO_UE, Z * APEX_TO_UE, Y * APEX_TO_UE);
	}

	FORCEINLINE FVector ApexDirToUE(double X, double Y, double Z)
	{
		return FVector(X, Z, Y);
	}

	/** Unreal world position back into Apex metres. */
	FORCEINLINE void UEToApex(const FVector& P, double& OutX, double& OutY, double& OutZ)
	{
		OutX = P.X / APEX_TO_UE;
		OutY = P.Z / APEX_TO_UE;
		OutZ = P.Y / APEX_TO_UE;
	}

	/** m:ss.mmm */
	APEXHORIZON_API FString FormatTime(double Seconds);

	/** +s.mmm */
	APEXHORIZON_API FString FormatGap(double Seconds);
}
