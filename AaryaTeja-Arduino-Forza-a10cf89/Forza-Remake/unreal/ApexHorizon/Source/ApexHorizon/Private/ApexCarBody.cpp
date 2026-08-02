// Apex Horizon — procedural car bodies.

#include "ApexCarBody.h"
#include "ApexCarData.h"
#include "ApexMath.h"
#include "ApexMeshBuilder.h"

using namespace ApexMath;

namespace
{
	/** One cross-section of the body, positioned along the car's length. */
	struct FStation
	{
		double T;          // 0 at the tail, 1 at the nose
		double HalfWidth;  // fraction of the car's half-width
		double Bottom;     // metres above ground
		double Top;        // metres above ground
	};

	struct FBodyProfile
	{
		TArray<FStation> Stations;
		double CabinFront = 0.66;   // where the greenhouse ends, in T
		double CabinRear = 0.24;
		double CabinTop = 1.42;     // metres above ground
		double CabinInset = 0.80;   // greenhouse half-width vs body half-width
		double NoseDrop = 0.0;
	};

	FBodyProfile MakeProfile(EApexBodyProfile Kind, const FApexBodySpec& Body)
	{
		FBodyProfile P;
		const double W = 1.0;

		switch (Kind)
		{
		case EApexBodyProfile::Hatch:
			P.Stations = {
				{ 0.00, 0.78 * W, 0.42, 1.06 },
				{ 0.08, 0.92 * W, 0.30, 1.24 },
				{ 0.22, 1.00 * W, 0.24, 1.30 },
				{ 0.40, 1.00 * W, 0.22, 1.28 },
				{ 0.58, 1.00 * W, 0.22, 1.24 },
				{ 0.74, 0.98 * W, 0.24, 1.14 },
				{ 0.88, 0.90 * W, 0.28, 0.98 },
				{ 1.00, 0.74 * W, 0.34, 0.86 },
			};
			P.CabinRear = 0.18; P.CabinFront = 0.70; P.CabinTop = 1.46; P.CabinInset = 0.84;
			break;

		case EApexBodyProfile::Coupe:
			P.Stations = {
				{ 0.00, 0.76 * W, 0.40, 0.94 },
				{ 0.10, 0.94 * W, 0.28, 1.06 },
				{ 0.26, 1.00 * W, 0.22, 1.12 },
				{ 0.44, 1.00 * W, 0.20, 1.12 },
				{ 0.62, 1.00 * W, 0.20, 1.10 },
				{ 0.78, 0.98 * W, 0.22, 1.02 },
				{ 0.90, 0.88 * W, 0.26, 0.92 },
				{ 1.00, 0.68 * W, 0.30, 0.80 },
			};
			P.CabinRear = 0.26; P.CabinFront = 0.62; P.CabinTop = 1.30; P.CabinInset = 0.80;
			break;

		case EApexBodyProfile::SUV:
			P.Stations = {
				{ 0.00, 0.84 * W, 0.52, 1.52 },
				{ 0.08, 0.96 * W, 0.44, 1.62 },
				{ 0.22, 1.00 * W, 0.40, 1.64 },
				{ 0.42, 1.00 * W, 0.38, 1.62 },
				{ 0.60, 1.00 * W, 0.38, 1.60 },
				{ 0.76, 0.99 * W, 0.40, 1.52 },
				{ 0.90, 0.94 * W, 0.44, 1.34 },
				{ 1.00, 0.82 * W, 0.50, 1.20 },
			};
			P.CabinRear = 0.16; P.CabinFront = 0.72; P.CabinTop = 1.80; P.CabinInset = 0.88;
			break;

		case EApexBodyProfile::Super:
			P.Stations = {
				{ 0.00, 0.82 * W, 0.34, 0.92 },
				{ 0.10, 0.98 * W, 0.22, 1.02 },
				{ 0.26, 1.00 * W, 0.16, 1.06 },
				{ 0.44, 1.00 * W, 0.14, 1.06 },
				{ 0.62, 0.99 * W, 0.14, 1.02 },
				{ 0.78, 0.94 * W, 0.16, 0.90 },
				{ 0.90, 0.86 * W, 0.18, 0.76 },
				{ 1.00, 0.66 * W, 0.20, 0.66 },
			};
			P.CabinRear = 0.30; P.CabinFront = 0.60; P.CabinTop = 1.16; P.CabinInset = 0.74;
			break;

		case EApexBodyProfile::GT3:
		default:
			P.Stations = {
				{ 0.00, 0.88 * W, 0.28, 0.96 },
				{ 0.10, 1.00 * W, 0.16, 1.04 },
				{ 0.26, 1.00 * W, 0.11, 1.10 },
				{ 0.44, 1.00 * W, 0.10, 1.10 },
				{ 0.62, 1.00 * W, 0.10, 1.06 },
				{ 0.78, 0.96 * W, 0.12, 0.92 },
				{ 0.90, 0.90 * W, 0.14, 0.76 },
				{ 1.00, 0.72 * W, 0.16, 0.62 },
			};
			P.CabinRear = 0.28; P.CabinFront = 0.62; P.CabinTop = 1.20; P.CabinInset = 0.76;
			break;
		}

		// scale the silhouette heights with the car's actual ride height
		const double Lift = Body.RideHeight - 0.12;
		for (FStation& St : P.Stations)
		{
			St.Bottom += Lift;
			St.Top += Lift;
		}
		P.CabinTop += Lift;
		return P;
	}

	/** Superellipse ring: flatter underneath, rounded on top. */
	FVector RingPoint(double Angle, double HalfWidth, double Bottom, double Top)
	{
		const double Cz = (Top + Bottom) * 0.5;
		const double Hz = (Top - Bottom) * 0.5;
		const double Cos = FMath::Cos(Angle), Sin = FMath::Sin(Angle);
		const double N = Sin >= 0.0 ? 3.0 : 6.0;   // top / bottom exponent
		const double Y = HalfWidth * FMath::Sign(Cos) * FMath::Pow(FMath::Abs(Cos), 2.0 / N);
		const double Z = Cz + Hz * FMath::Sign(Sin) * FMath::Pow(FMath::Abs(Sin), 2.0 / N);
		return FVector(0.0, Y, Z);
	}

	constexpr int32 RingSegments = 16;

	/** Interpolate a station value at T across the profile. */
	void SampleProfile(const FBodyProfile& P, double T, double& OutHw, double& OutBottom, double& OutTop)
	{
		const TArray<FStation>& St = P.Stations;
		if (T <= St[0].T)
		{
			OutHw = St[0].HalfWidth; OutBottom = St[0].Bottom; OutTop = St[0].Top;
			return;
		}
		for (int32 i = 1; i < St.Num(); ++i)
		{
			if (T <= St[i].T)
			{
				const double F = (T - St[i - 1].T) / FMath::Max(St[i].T - St[i - 1].T, 1e-6);
				const double S = F * F * (3.0 - 2.0 * F);   // ease so the surface stays smooth
				OutHw = Lerp(St[i - 1].HalfWidth, St[i].HalfWidth, S);
				OutBottom = Lerp(St[i - 1].Bottom, St[i].Bottom, S);
				OutTop = Lerp(St[i - 1].Top, St[i].Top, S);
				return;
			}
		}
		OutHw = St.Last().HalfWidth; OutBottom = St.Last().Bottom; OutTop = St.Last().Top;
	}
}

void ApexCarBody::Build(const FApexCar& Car, FApexMeshGroup& Out)
{
	const FApexBodySpec& B = Car.Body;
	const FBodyProfile P = MakeProfile(B.Profile, B);

	const double HalfLen = B.Length * 0.5;
	const double HalfWid = B.Width * 0.5;

	FApexMeshData& Paint = Out.SectionFor("carPaint");
	FApexMeshData& Glass = Out.SectionFor("glass");
	FApexMeshData& Trim = Out.SectionFor("carTrim");
	FApexMeshData& Head = Out.SectionFor("headlight");
	FApexMeshData& Tail = Out.SectionFor("taillight");

	/* ── main body loft ──────────────────────────────────────────────────────── */
	constexpr int32 Rings = 26;
	const int32 BodyBase = Paint.Vertices.Num();

	for (int32 R = 0; R <= Rings; ++R)
	{
		const double T = static_cast<double>(R) / Rings;
		double Hw, Bottom, Top;
		SampleProfile(P, T, Hw, Bottom, Top);

		const double X = (-HalfLen + T * B.Length) * APEX_TO_UE;
		for (int32 Sg = 0; Sg < RingSegments; ++Sg)
		{
			const double A = (2.0 * PI * Sg) / RingSegments;
			const FVector Local = RingPoint(A, Hw * HalfWid, Bottom, Top);
			Paint.AddVertex(
				FVector(X, Local.Y * APEX_TO_UE, Local.Z * APEX_TO_UE),
				FVector2D(static_cast<double>(Sg) / RingSegments, T * B.Length * 0.6));
		}
	}

	for (int32 R = 0; R < Rings; ++R)
	{
		for (int32 Sg = 0; Sg < RingSegments; ++Sg)
		{
			const int32 A = BodyBase + R * RingSegments + Sg;
			const int32 Bv = BodyBase + R * RingSegments + (Sg + 1) % RingSegments;
			const int32 Cv = BodyBase + (R + 1) * RingSegments + (Sg + 1) % RingSegments;
			const int32 Dv = BodyBase + (R + 1) * RingSegments + Sg;
			Paint.AddQuad(A, Bv, Cv, Dv);
		}
	}

	// close the tail and nose
	for (int32 End = 0; End < 2; ++End)
	{
		const int32 RingStart = BodyBase + (End == 0 ? 0 : Rings * RingSegments);
		double Hw, Bottom, Top;
		SampleProfile(P, End == 0 ? 0.0 : 1.0, Hw, Bottom, Top);
		const double X = (End == 0 ? -HalfLen : HalfLen) * APEX_TO_UE;
		const int32 Centre = Paint.AddVertex(
			FVector(X, 0.0, (Bottom + Top) * 0.5 * APEX_TO_UE), FVector2D(0.5, 0.5));
		for (int32 Sg = 0; Sg < RingSegments; ++Sg)
		{
			const int32 A = RingStart + Sg;
			const int32 Bv = RingStart + (Sg + 1) % RingSegments;
			if (End == 0)
			{
				Paint.AddTriangle(Centre, Bv, A);
			}
			else
			{
				Paint.AddTriangle(Centre, A, Bv);
			}
		}
	}

	/* ── greenhouse ──────────────────────────────────────────────────────────── */
	{
		constexpr int32 CabinRings = 12;
		constexpr int32 CabinSegs = 12;
		const int32 CabinBase = Glass.Vertices.Num();

		for (int32 R = 0; R <= CabinRings; ++R)
		{
			const double F = static_cast<double>(R) / CabinRings;
			const double T = Lerp(P.CabinRear, P.CabinFront, F);
			double Hw, Bottom, Top;
			SampleProfile(P, T, Hw, Bottom, Top);

			// taper the cabin toward both ends so it reads as a windscreen and backlight
			const double Ease = FMath::Sin(F * PI);
			const double CabinHw = Hw * HalfWid * P.CabinInset * (0.62 + 0.38 * Ease);
			const double CabinTop = Lerp(Top + 0.02, P.CabinTop, PowSafe(Ease, 0.6));
			const double X = (-HalfLen + T * B.Length) * APEX_TO_UE;

			for (int32 Sg = 0; Sg <= CabinSegs; ++Sg)
			{
				// half ring: only the upper surface is glazed
				const double A = PI * static_cast<double>(Sg) / CabinSegs;
				const FVector Local = RingPoint(A, CabinHw, Top - 0.04, CabinTop);
				Glass.AddVertex(
					FVector(X, Local.Y * APEX_TO_UE, Local.Z * APEX_TO_UE),
					FVector2D(static_cast<double>(Sg) / CabinSegs, F));
			}
		}

		const int32 Stride = CabinSegs + 1;
		for (int32 R = 0; R < CabinRings; ++R)
		{
			for (int32 Sg = 0; Sg < CabinSegs; ++Sg)
			{
				const int32 A = CabinBase + R * Stride + Sg;
				const int32 Bv = CabinBase + R * Stride + Sg + 1;
				const int32 Cv = CabinBase + (R + 1) * Stride + Sg + 1;
				const int32 Dv = CabinBase + (R + 1) * Stride + Sg;
				Glass.AddQuad(A, Bv, Cv, Dv);
			}
		}
	}

	/* ── lights ──────────────────────────────────────────────────────────────── */
	{
		double NoseHw, NoseBottom, NoseTop;
		SampleProfile(P, 0.96, NoseHw, NoseBottom, NoseTop);
		const double LampZ = Lerp(NoseBottom, NoseTop, 0.62) * APEX_TO_UE;
		const double NoseX = (HalfLen - 0.10) * APEX_TO_UE;

		for (double Side : { 1.0, -1.0 })
		{
			const FVector Pos(NoseX, Side * NoseHw * HalfWid * 0.66 * APEX_TO_UE, LampZ);
			Head.AddBox(Pos, FVector(6, 22, 7), FQuat::Identity, FColor::White);
		}

		double TailHw, TailBottom, TailTop;
		SampleProfile(P, 0.04, TailHw, TailBottom, TailTop);
		const double TailZ = Lerp(TailBottom, TailTop, 0.66) * APEX_TO_UE;
		const double TailX = (-HalfLen + 0.08) * APEX_TO_UE;
		for (double Side : { 1.0, -1.0 })
		{
			const FVector Pos(TailX, Side * TailHw * HalfWid * 0.68 * APEX_TO_UE, TailZ);
			Tail.AddBox(Pos, FVector(5, 20, 6), FQuat::Identity, FColor::White);
		}
	}

	/* ── bumpers, splitter, diffuser, mirrors ────────────────────────────────── */
	{
		double NoseHw, NoseBottom, NoseTop;
		SampleProfile(P, 0.99, NoseHw, NoseBottom, NoseTop);
		Trim.AddBox(
			FVector((HalfLen - 0.05) * APEX_TO_UE, 0, (NoseBottom + 0.03) * APEX_TO_UE),
			FVector(10, NoseHw * HalfWid * 0.96 * APEX_TO_UE, 5),
			FQuat::Identity, FColor(20, 21, 24));

		double TailHw, TailBottom, TailTop;
		SampleProfile(P, 0.01, TailHw, TailBottom, TailTop);
		Trim.AddBox(
			FVector((-HalfLen + 0.05) * APEX_TO_UE, 0, (TailBottom + 0.04) * APEX_TO_UE),
			FVector(12, TailHw * HalfWid * 0.92 * APEX_TO_UE, 7),
			FQuat::Identity, FColor(20, 21, 24));

		// door mirrors
		double MirrorHw, MirrorBottom, MirrorTop;
		SampleProfile(P, P.CabinRear + (P.CabinFront - P.CabinRear) * 0.18, MirrorHw, MirrorBottom, MirrorTop);
		for (double Side : { 1.0, -1.0 })
		{
			const FVector Pos(
				(-HalfLen + (P.CabinRear + (P.CabinFront - P.CabinRear) * 0.15) * B.Length) * APEX_TO_UE,
				Side * (MirrorHw * HalfWid + 0.12) * APEX_TO_UE,
				(MirrorTop + 0.04) * APEX_TO_UE);
			Trim.AddBox(Pos, FVector(5, 9, 5), FQuat::Identity, FColor(20, 21, 24));
		}
	}

	/* ── rear wing ───────────────────────────────────────────────────────────── */
	if (B.WingSize > 0.25)
	{
		double Hw, Bottom, Top;
		SampleProfile(P, 0.08, Hw, Bottom, Top);
		const double WingZ = (Top + 0.12 + 0.30 * B.WingSize) * APEX_TO_UE;
		const double WingX = (-HalfLen + 0.28) * APEX_TO_UE;
		const double WingHalfW = Hw * HalfWid * 0.98 * APEX_TO_UE;

		if (B.WingSize > 0.55)
		{
			// free-standing wing on endplates
			Trim.AddBox(FVector(WingX, 0, WingZ), FVector(16 + 10 * B.WingSize, WingHalfW, 3.5),
				FQuat::Identity, FColor(24, 25, 28));
			for (double Side : { 1.0, -1.0 })
			{
				Trim.AddBox(
					FVector(WingX, Side * WingHalfW, WingZ - (0.16 * B.WingSize) * APEX_TO_UE),
					FVector(22, 2.5, (0.18 * B.WingSize) * APEX_TO_UE),
					FQuat::Identity, FColor(24, 25, 28));
			}
		}
		else
		{
			// integrated ducktail
			Paint.AddBox(FVector(WingX, 0, (Top + 0.05) * APEX_TO_UE),
				FVector(12, WingHalfW * 0.94, 3), FQuat::Identity, FColor::White);
		}
	}

	Out.ComputeNormals();
	Out.Compact();
}

void ApexCarBody::BuildWheel(double Radius, double Width, int32 RimStyle, FApexMeshGroup& Out)
{
	FApexMeshData& Tyre = Out.SectionFor("tyre");
	FApexMeshData& Rim = Out.SectionFor("rim");
	FApexMeshData& Disc = Out.SectionFor("brakeDisc");
	FApexMeshData& Caliper = Out.SectionFor("caliper");

	const double R = Radius * APEX_TO_UE;
	const double HalfW = Width * 0.5 * APEX_TO_UE;

	// The wheel's axle runs along local Y, so cylinders are built rotated onto that axis.
	const FQuat Axle = FRotationMatrix::MakeFromZ(FVector::RightVector).ToQuat();

	// tyre carcass
	Tyre.AddCylinder(FVector(0, -HalfW, 0), R, R, HalfW * 2.0, 24, Axle, FColor(26, 27, 29), false);
	// sidewalls
	Tyre.AddCylinder(FVector(0, -HalfW, 0), R, R * 0.68, HalfW * 0.22, 24, Axle, FColor(22, 23, 25), true);
	Tyre.AddCylinder(FVector(0, HalfW - HalfW * 0.22, 0), R * 0.68, R, HalfW * 0.22, 24, Axle, FColor(22, 23, 25), true);

	// rim barrel and face
	const double RimR = R * 0.66;
	Rim.AddCylinder(FVector(0, -HalfW * 0.9, 0), RimR, RimR, HalfW * 1.8, 20, Axle, FColor(190, 196, 206), true);

	// spokes — the style just changes how many and how wide
	const int32 Spokes = RimStyle == 0 ? 5 : (RimStyle == 1 ? 8 : (RimStyle == 2 ? 10 : 6));
	const double SpokeWidth = RimStyle == 3 ? 0.16 : 0.09;
	for (int32 i = 0; i < Spokes; ++i)
	{
		const double A = (2.0 * PI * i) / Spokes;
		const FQuat Rot = FQuat(FVector::RightVector, A);
		Rim.AddBox(
			FVector(FMath::Cos(A) * RimR * 0.5, HalfW * 0.72, FMath::Sin(A) * RimR * 0.5),
			FVector(RimR * 0.46, HalfW * 0.10, RimR * SpokeWidth),
			Rot, FColor(180, 186, 198));
	}

	// brake disc and caliper sit inboard of the rim face
	Disc.AddCylinder(FVector(0, -HalfW * 0.28, 0), R * 0.52, R * 0.52, HalfW * 0.16, 18, Axle, FColor::White, true);
	Caliper.AddBox(FVector(-R * 0.42, -HalfW * 0.22, R * 0.18),
		FVector(R * 0.16, HalfW * 0.22, R * 0.22), FQuat::Identity, FColor::White);

	Out.ComputeNormals();
	Out.Compact();
}

void ApexCarBody::GetCollisionExtents(const FApexCar& Car, FVector& OutCenter, FVector& OutHalfExtents)
{
	const FApexBodySpec& B = Car.Body;
	const FBodyProfile P = MakeProfile(B.Profile, B);

	double MinZ = TNumericLimits<double>::Max();
	double MaxZ = -TNumericLimits<double>::Max();
	for (const FStation& St : P.Stations)
	{
		MinZ = FMath::Min(MinZ, St.Bottom);
		MaxZ = FMath::Max(MaxZ, St.Top);
	}

	OutCenter = FVector(0.0, 0.0, (MinZ + MaxZ) * 0.5 * APEX_TO_UE);
	OutHalfExtents = FVector(
		B.Length * 0.5 * APEX_TO_UE * 0.98,
		B.Width * 0.5 * APEX_TO_UE * 0.94,
		(MaxZ - MinZ) * 0.5 * APEX_TO_UE);
}
