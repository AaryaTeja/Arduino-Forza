// Apex Horizon — terrain generation.

#include "ApexTerrain.h"
#include "ApexMath.h"
#include "ApexMeshBuilder.h"
#include "ApexTrackSpline.h"

using namespace ApexMath;
using namespace ApexWorld;

double ApexBaseHeight(double X, double Z, bool bWithCanyon)
{
	double H = 0.0;
	H += 21.0 * Fbm2(X * 0.00062, Z * 0.00062, 3);
	H += 11.5 * Fbm2(X * 0.0017 + 31.2, Z * 0.0017 - 12.7, 4);
	H += 3.4 * Fbm2(X * 0.0061 - 5.1, Z * 0.0061 + 8.8, 3);
	H += 1.1 * Fbm2(X * 0.019, Z * 0.019, 2);
	H += 16.0;

	// a couple of distinct hills so the circuit has real elevation change
	H += 46.0 * FMath::Exp(-((FMath::Square(X - 690.0) + FMath::Square(Z + 60.0)) / (2.0 * 300.0 * 300.0)));  // tunnel hill (east)
	H += 34.0 * FMath::Exp(-((FMath::Square(X + 260.0) + FMath::Square(Z + 210.0)) / (2.0 * 340.0 * 340.0))); // central rise
	H += 28.0 * FMath::Exp(-((FMath::Square(X + 620.0) + FMath::Square(Z - 40.0)) / (2.0 * 260.0 * 260.0)));  // west ridge

	// flatten the city basin
	const double Cd = FMath::Sqrt(FMath::Square(X - CityX) + FMath::Square(Z - CityZ));
	const double Ct = SmoothStep(CityRadius, CityRadius + CityFalloff, Cd);
	H = Lerp(CityFlatY + 2.2 * Fbm2(X * 0.004, Z * 0.004, 2), H, Ct);

	// carve the canyon
	if (bWithCanyon)
	{
		double D2 = 0.0, T = 0.0;
		SegDist2(X, Z, CanyonAx, CanyonAz, CanyonBx, CanyonBz, D2, T);
		const double D = FMath::Sqrt(D2);
		const double Taper = 1.0 - SmoothStep(CanyonTaperFrom, 1.0, T);
		if (Taper > 0.001)
		{
			const double Bank = SmoothStep(CanyonWidth * 0.45, CanyonWidth * 2.4, D);
			const double Bed = CanyonBedY + (1.0 - Taper) * 26.0;
			H = Lerp(Lerp(Bed, H, Bank), H, 1.0 - Taper);
		}
	}

	// ring of mountains keeps the player inside the playable area
	const double Edge = FMath::Max(FMath::Abs(X), FMath::Abs(Z));
	if (Edge > MountainStart)
	{
		const double E = Edge - MountainStart;
		H += E * E * MountainRise * (0.85 + 0.3 * Fbm2(X * 0.0035, Z * 0.0035, 3));
	}
	return H;
}

FApexTerrain::FApexTerrain(const FApexTrackSpline& InSpline)
	: Spline(InSpline)
{
	Heights.SetNumZeroed((N + 1) * (N + 1));
}

double FApexTerrain::Height(double X, double Z) const
{
	const double Base = ApexBaseHeight(X, Z);

	const FApexSplineQuery Q = Spline.Query(X, Z);
	if (Q.bFar || Q.Index < 0)
	{
		return Base;
	}

	const int32 J = (Q.Index + 1) % Spline.Count;
	const double W = Lerp(Spline.FlattenWeight[Q.Index], Spline.FlattenWeight[J], Q.T);
	if (W <= 0.001)
	{
		return Base;
	}

	const double Inner = Q.HalfWidth + 2.5;
	const double Outer = Q.HalfWidth + 40.0;
	const double Blend = SmoothStep(Inner, Outer, Q.Dist);
	const double Target = Q.Y - 0.55;
	const double Levelled = Lerp(Target, Base, Blend);
	return Lerp(Base, Levelled, W);
}

void FApexTerrain::Build()
{
	constexpr double S = Size;
	constexpr double HalfS = Size * 0.5;

	for (int32 Ix = 0; Ix <= N; ++Ix)
	{
		const double X = (static_cast<double>(Ix) / N) * S - HalfS;
		for (int32 Iz = 0; Iz <= N; ++Iz)
		{
			const double Z = (static_cast<double>(Iz) / N) * S - HalfS;
			Heights[Ix * (N + 1) + Iz] = Height(X, Z);
		}
	}
}

double FApexTerrain::HeightAtGrid(int32 Ix, int32 Iz) const
{
	const int32 Cx = FMath::Clamp(Ix, 0, N);
	const int32 Cz = FMath::Clamp(Iz, 0, N);
	return Heights[Cx * (N + 1) + Cz];
}

double FApexTerrain::Sample(double X, double Z) const
{
	constexpr double S = Size;
	constexpr double HalfS = Size * 0.5;
	const double Fx = FMath::Clamp(((X + HalfS) / S) * N, 0.0, static_cast<double>(N));
	const double Fz = FMath::Clamp(((Z + HalfS) / S) * N, 0.0, static_cast<double>(N));
	const int32 Ix = FMath::FloorToInt32(Fx), Iz = FMath::FloorToInt32(Fz);
	const double Tx = Fx - Ix, Tz = Fz - Iz;
	const double H00 = HeightAtGrid(Ix, Iz);
	const double H10 = HeightAtGrid(Ix + 1, Iz);
	const double H01 = HeightAtGrid(Ix, Iz + 1);
	const double H11 = HeightAtGrid(Ix + 1, Iz + 1);
	return Lerp(Lerp(H00, H10, Tx), Lerp(H01, H11, Tx), Tz);
}

void FApexTerrain::BuildMeshTile(int32 TileX, int32 TileZ, int32 TilesPerSide, FApexMeshData& Out) const
{
	constexpr double S = Size;
	constexpr double HalfS = Size * 0.5;
	constexpr double CellSize = S / N;

	const int32 PerTile = N / TilesPerSide;
	const int32 X0 = TileX * PerTile;
	const int32 Z0 = TileZ * PerTile;
	const int32 X1 = FMath::Min(X0 + PerTile, N);
	const int32 Z1 = FMath::Min(Z0 + PerTile, N);
	const int32 Stride = (Z1 - Z0) + 1;

	// Ground-cover palette, in linear space.
	const FLinearColor GrassA = FLinearColor(FColor(0x33, 0x63, 0x2a));
	const FLinearColor GrassB = FLinearColor(FColor(0x4f, 0x7a, 0x2c));
	const FLinearColor DryGrass = FLinearColor(FColor(0x7d, 0x83, 0x39));
	const FLinearColor Dirt = FLinearColor(FColor(0x5e, 0x4a, 0x30));
	const FLinearColor Rock = FLinearColor(FColor(0x63, 0x60, 0x5b));
	const FLinearColor Sand = FLinearColor(FColor(0x96, 0x87, 0x5f));
	const FLinearColor Snow = FLinearColor(FColor(0xe8, 0xed, 0xf2));

	Out.Reserve(Stride * ((X1 - X0) + 1), (X1 - X0) * (Z1 - Z0) * 2);

	for (int32 Ix = X0; Ix <= X1; ++Ix)
	{
		const double X = (static_cast<double>(Ix) / N) * S - HalfS;
		for (int32 Iz = Z0; Iz <= Z1; ++Iz)
		{
			const double Z = (static_cast<double>(Iz) / N) * S - HalfS;
			const double Y = Heights[Ix * (N + 1) + Iz];

			// slope from neighbouring samples
			const double Hx = HeightAtGrid(Ix + 1, Iz) - HeightAtGrid(Ix - 1, Iz);
			const double Hz = HeightAtGrid(Ix, Iz + 1) - HeightAtGrid(Ix, Iz - 1);
			const double Slope = FMath::Sqrt(Hx * Hx + Hz * Hz) / (2.0 * CellSize);

			const double N1 = Fbm2(X * 0.0042, Z * 0.0042, 3);
			const double N2 = Fbm2(X * 0.021, Z * 0.021, 2);

			FLinearColor C = FMath::Lerp(GrassA, GrassB, static_cast<float>(Clamp01(0.5 + N1 * 0.9)));
			C = FMath::Lerp(C, DryGrass, static_cast<float>(Clamp01(SmoothStep(0.1, 0.55, N1 * 0.7 + 0.2) * 0.55)));
			C = FMath::Lerp(C, Dirt, static_cast<float>(SmoothStep(0.30, 0.62, Slope)));
			C = FMath::Lerp(C, Rock, static_cast<float>(SmoothStep(0.60, 1.05, Slope)));
			C = FMath::Lerp(C, Sand, static_cast<float>(SmoothStep(4.0, -1.5, Y - WaterLevel) * 0.85));
			C = FMath::Lerp(C, Snow, static_cast<float>(SmoothStep(118.0, 172.0, Y + N2 * 14.0)));
			const float Shade = static_cast<float>(0.9 + N2 * 0.12);
			C *= Shade;
			C.A = 1.f;

			Out.AddVertex(ApexToUE(X, Y, Z), FVector2D(X / 44.0, Z / 44.0), C.ToFColor(false));
		}
	}

	for (int32 Ix = X0; Ix < X1; ++Ix)
	{
		for (int32 Iz = Z0; Iz < Z1; ++Iz)
		{
			const int32 A = (Ix - X0) * Stride + (Iz - Z0);
			const int32 B = (Ix - X0 + 1) * Stride + (Iz - Z0);
			const int32 Cc = (Ix - X0 + 1) * Stride + (Iz - Z0 + 1);
			const int32 D = (Ix - X0) * Stride + (Iz - Z0 + 1);
			// winding chosen so the surface normal points up
			Out.AddTriangle(A, D, B);
			Out.AddTriangle(B, D, Cc);
		}
	}

	Out.ComputeNormals();
}

void FApexTerrain::BuildWater(FApexMeshData& Out) const
{
	constexpr int32 Steps = 60;
	const double Dx = CanyonBx - CanyonAx;
	const double Dz = CanyonBz - CanyonAz;
	const double Len = FMath::Sqrt(Dx * Dx + Dz * Dz);
	const double Ux = Dx / Len, Uz = Dz / Len;
	const double Px = Uz, Pz = -Ux;

	for (int32 i = 0; i <= Steps; ++i)
	{
		const double T = static_cast<double>(i) / Steps;
		const double Cx = CanyonAx + Dx * T;
		const double Cz = CanyonAz + Dz * T;
		const double Taper = 1.0 - SmoothStep(CanyonTaperFrom, 1.0, T);
		const double W = CanyonWidth * 0.62 * Taper;
		const double Y = WaterLevel + (1.0 - Taper) * 22.0;
		const double V = T * Len / 30.0;
		Out.AddVertex(ApexToUE(Cx + Px * W, Y, Cz + Pz * W), FVector2D(0.0, V));
		Out.AddVertex(ApexToUE(Cx - Px * W, Y, Cz - Pz * W), FVector2D(1.0, V));
	}

	for (int32 i = 0; i < Steps; ++i)
	{
		const int32 A = i * 2;
		Out.AddTriangle(A, A + 1, A + 2);
		Out.AddTriangle(A + 1, A + 3, A + 2);
	}

	Out.ComputeNormals();
}
