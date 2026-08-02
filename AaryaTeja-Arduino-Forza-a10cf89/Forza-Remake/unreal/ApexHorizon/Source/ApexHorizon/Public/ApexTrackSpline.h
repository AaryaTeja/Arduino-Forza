// Apex Horizon — closed, arc-length-parameterised centreline for the circuit.
//
// Everything downstream (road mesh, terrain flattening, AI racing line, checkpoints,
// minimap, grip lookup) reads from the same sample arrays so they can never drift apart.
// Works in Apex space: metres, X/Z horizontal, Y up.

#pragma once

#include "CoreMinimal.h"

/** Result of a nearest-point query against the centreline. */
struct APEXHORIZON_API FApexSplineQuery
{
	int32 Index = -1;
	double T = 0.0;
	double Dist = 0.0;
	double SignedDist = 0.0;
	double Y = 0.0;
	double S = 0.0;
	double HalfWidth = 8.0;
	/** Distance beyond the drivable surface (tarmac + shoulder); 0 while on it. */
	double EdgeDistance = 0.0;
	bool bOnRoad = false;
	bool bFar = false;
};

/** Interpolated sample of the centreline at a given arc length. */
struct APEXHORIZON_API FApexSplineSample
{
	int32 Index = 0;
	double T = 0.0;
	double X = 0.0, Y = 0.0, Z = 0.0;
	double Tx = 0.0, Ty = 0.0, Tz = 0.0;
	double Nx = 0.0, Nz = 0.0;
	double Curvature = 0.0;
	double HalfWidth = 8.0;
	double Bank = 0.0;
	uint8 Flags = 0;
};

class APEXHORIZON_API FApexTrackSpline
{
public:
	static constexpr uint8 FLAG_BRIDGE = 1;
	static constexpr uint8 FLAG_TUNNEL = 2;
	static constexpr uint8 FLAG_CITY = 4;

	/**
	 * @param ControlPoints XZ control points, closed loop.
	 * @param Spacing target metres between samples.
	 */
	FApexTrackSpline(const TArray<FVector2D>& ControlPoints, double Spacing = 3.0);

	int32 Count = 0;
	double Length = 0.0;

	TArray<double> X, Y, Z;
	TArray<double> Tx, Ty, Tz;      // tangent
	TArray<double> Nx, Nz;          // lateral normal in XZ
	TArray<double> Curvature;       // signed, 1/m
	TArray<double> Bank;
	TArray<double> S;               // arc length at sample
	TArray<double> Width;           // road half-width
	TArray<uint8>  Flags;
	TArray<double> FlattenWeight;   // how strongly terrain is levelled beside the road

	/**
	 * Assign elevation from a base terrain function, then smooth it so the road rolls
	 * over hills instead of tracing every bump, and clamp the gradient.
	 */
	void BuildElevation(TFunctionRef<double(double, double)> BaseHeightFn,
		int32 SmoothRadius = 26, int32 Passes = 5, double MaxGrade = 0.085, double Lift = 0.0);

	/** Bank the road into corners; capped so it never feels like a wall of death. */
	void BuildBanking(double MaxBankRad = 0.10);

	/** Vary road width — wider through fast sweepers, tighter in town. */
	void BuildWidth(double Base = 8.0, double CityHalf = 7.0);

	void MarkFlag(int32 StartIdx, int32 EndIdx, uint8 Flag);

	/** Index of the sample nearest a world XZ position — brute force, used only at setup. */
	int32 NearestIndexSlow(double InX, double InZ) const;

	/** Build a uniform-grid accelerator for nearest-sample queries. */
	void BuildLookup(double MinX, double MinZ, double MaxX, double MaxZ, double Cell = 24.0, double SearchRadius = 90.0);

	FApexSplineQuery Query(double InX, double InZ) const;
	FApexSplineSample SampleAt(double InS) const;

	/** Forward arc distance from a to b, in [0, Length). */
	double ForwardArc(double Sa, double Sb) const;
	/** Signed shortest arc from a to b, in [-Length/2, Length/2]. */
	double SignedArc(double Sa, double Sb) const;

	/** Circular box blur, in place. */
	void Smooth(TArray<double>& Arr, int32 Radius, int32 Passes = 1) const;

	/**
	 * Orthonormal frame at a sample, including road banking, in Apex space.
	 * OutFwd is the unit tangent; OutRight is the lateral axis; OutUp completes the frame.
	 */
	void FrameAt(int32 Index, FVector& OutRight, FVector& OutUp, FVector& OutFwd) const;

private:
	void ComputeArcLength();
	void ComputeFrames();
	double ArcBetween(int32 A, int32 B) const;

	// nearest-sample lookup grid
	double LuMinX = 0.0, LuMinZ = 0.0, LuCell = 24.0, LuSearchRadius = 90.0;
	int32 LuCols = 0, LuRows = 0;
	bool bHasLookup = false;
	TArray<TArray<int32>> LuBuckets;
};
