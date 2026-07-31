// Apex Horizon — vehicle catalogue.

#include "ApexCarData.h"
#include "ApexMath.h"

namespace
{
	/** Normalised torque curve, sampled against rpm / redline. */
	const double GTorqueCurve[][2] = {
		{0.00, 0.34}, {0.10, 0.60}, {0.20, 0.78}, {0.32, 0.90},
		{0.45, 0.975}, {0.58, 1.00}, {0.70, 0.985}, {0.82, 0.93},
		{0.93, 0.85}, {1.00, 0.77}, {1.10, 0.28},
	};
	constexpr int32 GTorqueCurveCount = UE_ARRAY_COUNT(GTorqueCurve);

	/** damping ≈ 2·sqrt(stiffness)·ζ, as in the Bullet raycast-vehicle convention. */
	FApexSuspensionSpec MakeSuspension(float Stiffness, float Travel, float Rest,
		double ZetaC = 0.72, double ZetaR = 0.86)
	{
		FApexSuspensionSpec S;
		S.Stiffness = Stiffness;
		S.Travel = Travel;
		S.Rest = Rest;
		S.Compression = static_cast<float>(2.0 * FMath::Sqrt(static_cast<double>(Stiffness)) * ZetaC);
		S.Relaxation = static_cast<float>(2.0 * FMath::Sqrt(static_cast<double>(Stiffness)) * ZetaR);
		return S;
	}

	FLinearColor Hex(uint32 Rgb)
	{
		return FLinearColor(FColor(
			static_cast<uint8>((Rgb >> 16) & 0xFF),
			static_cast<uint8>((Rgb >> 8) & 0xFF),
			static_cast<uint8>(Rgb & 0xFF)));
	}

	TArray<FApexCar> BuildCars()
	{
		TArray<FApexCar> Out;

		{
			FApexCar C;
			C.Id = "kestrel";
			C.Name = TEXT("Kestrel Type-S");
			C.Brand = TEXT("Nomura");
			C.Klass = TEXT("Hot Hatch · FWD");
			C.Price = 0;
			C.Blurb = TEXT("A 2.0-litre turbo hatch that punches far above its weight. Light, eager and forgiving — the ideal place to learn the Horizon loop before the money cars arrive.");
			C.Drivetrain = EApexDrivetrain::FWD;
			C.Mass = 1185.f;
			C.ComHeight = -0.14f;
			C.Engine = { 320.f, 6800.f, 850.f, 4, 0.75f, 0.24f };
			C.Gears = { 3.77f, 2.10f, 1.45f, 1.09f, 0.87f, 0.72f };
			C.ReverseGear = 3.55f;
			C.FinalDrive = 4.10f;
			C.DriveEfficiency = 0.90f;
			C.CdA = 0.74f;
			C.DownforceCoef = 0.28f;
			C.BrakeStrength = 0.34f;
			C.BrakeBias = 0.66f;
			C.SteerLock = 0.60f;
			C.TyreGripBase = 1.00f;
			C.Body = { 4.28f, 1.80f, 2.62f, 1.55f, 1.53f, 0.315f, 0.225f, 0.155f, EApexBodyProfile::Hatch, 0.35f, Hex(0x2f6fd6) };
			C.Suspension = MakeSuspension(34.f, 0.19f, 0.30f);
			Out.Add(MoveTemp(C));
		}
		{
			FApexCar C;
			C.Id = "aurelia";
			C.Name = TEXT("Aurelia GT");
			C.Brand = TEXT("Ferrante");
			C.Klass = TEXT("Grand Tourer · RWD");
			C.Price = 55000;
			C.Blurb = TEXT("A front-mid V8 grand tourer. Long wheelbase, huge torque and a chassis that will hold a slide all day — the definitive Horizon cruiser.");
			C.Drivetrain = EApexDrivetrain::RWD;
			C.Mass = 1490.f;
			C.ComHeight = -0.17f;
			C.Engine = { 505.f, 7400.f, 780.f, 8, 0.0f, 0.30f };
			C.Gears = { 3.44f, 2.21f, 1.60f, 1.24f, 1.00f, 0.80f, 0.67f };
			C.ReverseGear = 3.10f;
			C.FinalDrive = 3.73f;
			C.DriveEfficiency = 0.92f;
			C.CdA = 0.71f;
			C.DownforceCoef = 0.42f;
			C.BrakeStrength = 0.38f;
			C.BrakeBias = 0.62f;
			C.SteerLock = 0.55f;
			C.TyreGripBase = 1.06f;
			C.Body = { 4.71f, 1.94f, 2.80f, 1.66f, 1.68f, 0.345f, 0.275f, 0.135f, EApexBodyProfile::Coupe, 0.30f, Hex(0xc8102e) };
			C.Suspension = MakeSuspension(40.f, 0.17f, 0.29f);
			Out.Add(MoveTemp(C));
		}
		{
			FApexCar C;
			C.Id = "baron";
			C.Name = TEXT("Baron Trailmaster");
			C.Brand = TEXT("Kestrel Works");
			C.Klass = TEXT("Rally SUV · AWD");
			C.Price = 72000;
			C.Blurb = TEXT("Long-travel dampers, a locking centre diff and enough ground clearance to ignore the road entirely. Slower on tarmac, untouchable across country.");
			C.Drivetrain = EApexDrivetrain::AWD;
			C.Mass = 1905.f;
			C.ComHeight = -0.05f;
			C.Engine = { 630.f, 6200.f, 700.f, 6, 0.85f, 0.40f };
			C.Gears = { 3.90f, 2.42f, 1.68f, 1.22f, 0.94f, 0.78f };
			C.ReverseGear = 3.60f;
			C.FinalDrive = 3.90f;
			C.DriveEfficiency = 0.87f;
			C.CdA = 1.09f;
			C.DownforceCoef = 0.16f;
			C.BrakeStrength = 0.33f;
			C.BrakeBias = 0.60f;
			C.SteerLock = 0.62f;
			C.TyreGripBase = 1.00f;
			C.OffroadBonus = 0.42f;
			C.Body = { 4.86f, 2.02f, 2.90f, 1.72f, 1.72f, 0.405f, 0.295f, 0.285f, EApexBodyProfile::SUV, 0.20f, Hex(0xe0a02a) };
			C.Suspension = MakeSuspension(30.f, 0.30f, 0.40f, 0.62, 0.78);
			Out.Add(MoveTemp(C));
		}
		{
			FApexCar C;
			C.Id = "vulcan";
			C.Name = TEXT("Vulcan R8");
			C.Brand = TEXT("Ferrante");
			C.Klass = TEXT("Hypercar · AWD");
			C.Price = 148000;
			C.Blurb = TEXT("Twin-turbo flat-plane V8, all-wheel drive and active aero. Absurdly fast in a straight line and nearly as quick through the corners — if you can hold it.");
			C.Drivetrain = EApexDrivetrain::AWD;
			C.Mass = 1425.f;
			C.ComHeight = -0.20f;
			C.Engine = { 790.f, 8600.f, 950.f, 8, 0.95f, 0.22f };
			C.Gears = { 3.13f, 2.29f, 1.77f, 1.41f, 1.13f, 0.92f, 0.76f };
			C.ReverseGear = 2.90f;
			C.FinalDrive = 3.40f;
			C.DriveEfficiency = 0.93f;
			C.CdA = 0.72f;
			C.DownforceCoef = 0.72f;
			C.BrakeStrength = 0.45f;
			C.BrakeBias = 0.63f;
			C.SteerLock = 0.52f;
			C.TyreGripBase = 1.14f;
			C.Body = { 4.62f, 2.03f, 2.70f, 1.71f, 1.74f, 0.355f, 0.315f, 0.110f, EApexBodyProfile::Super, 0.62f, Hex(0xf2b705) };
			C.Suspension = MakeSuspension(50.f, 0.14f, 0.26f, 0.78, 0.90);
			Out.Add(MoveTemp(C));
		}
		{
			FApexCar C;
			C.Id = "mistral";
			C.Name = TEXT("Mistral GT3-R");
			C.Brand = TEXT("Scuderia Volante");
			C.Klass = TEXT("GT Racer · RWD");
			C.Price = 225000;
			C.Blurb = TEXT("A homologated GT3 car with a stripped tub, sequential box and a rear wing you could land a plane on. Merciless off the racing line, sublime on it.");
			C.Drivetrain = EApexDrivetrain::RWD;
			C.Mass = 1245.f;
			C.ComHeight = -0.24f;
			C.Engine = { 640.f, 8200.f, 1200.f, 6, 0.55f, 0.16f };
			C.Gears = { 2.92f, 2.15f, 1.72f, 1.42f, 1.19f, 1.00f };
			C.ReverseGear = 2.70f;
			C.FinalDrive = 3.85f;
			C.DriveEfficiency = 0.95f;
			C.CdA = 0.94f;
			C.DownforceCoef = 1.55f;
			C.BrakeStrength = 0.52f;
			C.BrakeBias = 0.64f;
			C.SteerLock = 0.48f;
			C.TyreGripBase = 1.22f;
			C.ShiftTimeBase = 0.055f;
			C.Body = { 4.72f, 2.05f, 2.72f, 1.78f, 1.76f, 0.360f, 0.340f, 0.085f, EApexBodyProfile::GT3, 1.0f, Hex(0xf5f7fa) };
			C.Suspension = MakeSuspension(62.f, 0.10f, 0.22f, 0.85, 0.95);
			Out.Add(MoveTemp(C));
		}

		return Out;
	}

	TArray<FApexTyreCompound> BuildTyres()
	{
		TArray<FApexTyreCompound> Out;
		Out.Add({ "street", TEXT("Street"), 1.02f, 0.78f, 0.62f, 0.90f, TEXT("Long-wearing all-season rubber. Predictable but soft on grip.") });
		Out.Add({ "sport",  TEXT("Sport"),  1.28f, 0.92f, 0.58f, 1.00f, TEXT("Semi-slick compound. Strong on tarmac, average in the wet.") });
		Out.Add({ "race",   TEXT("Race"),   1.62f, 0.86f, 0.40f, 1.15f, TEXT("Slick racing compound. Enormous dry grip, poor off the racing surface.") });
		Out.Add({ "rally",  TEXT("Rally"),  1.12f, 1.02f, 1.05f, 0.95f, TEXT("Knobbly gravel tyre. Transforms the car off-road, costs tarmac bite.") });
		return Out;
	}
}

double ApexTorqueFactor(double RpmFraction)
{
	if (RpmFraction <= GTorqueCurve[0][0])
	{
		return GTorqueCurve[0][1];
	}
	for (int32 i = 1; i < GTorqueCurveCount; ++i)
	{
		if (RpmFraction <= GTorqueCurve[i][0])
		{
			const double X0 = GTorqueCurve[i - 1][0], Y0 = GTorqueCurve[i - 1][1];
			const double X1 = GTorqueCurve[i][0], Y1 = GTorqueCurve[i][1];
			const double T = (RpmFraction - X0) / (X1 - X0);
			return Y0 + (Y1 - Y0) * T;
		}
	}
	return 0.15;
}

const TArray<FApexCar>& FApexCatalogue::Cars()
{
	static const TArray<FApexCar> Data = BuildCars();
	return Data;
}

const FApexCar* FApexCatalogue::FindCar(FName Id)
{
	for (const FApexCar& C : Cars())
	{
		if (C.Id == Id)
		{
			return &C;
		}
	}
	return nullptr;
}

const FApexCar& FApexCatalogue::CarAt(int32 Index)
{
	const TArray<FApexCar>& All = Cars();
	return All[FMath::Clamp(Index, 0, All.Num() - 1)];
}

const TArray<FApexTyreCompound>& FApexCatalogue::Tyres()
{
	static const TArray<FApexTyreCompound> Data = BuildTyres();
	return Data;
}

const FApexTyreCompound& FApexCatalogue::FindTyre(FName Id)
{
	const TArray<FApexTyreCompound>& All = Tyres();
	for (const FApexTyreCompound& T : All)
	{
		if (T.Id == Id)
		{
			return T;
		}
	}
	return All[1]; // sport
}

const TArray<FLinearColor>& FApexCatalogue::PaintPresets()
{
	static const TArray<FLinearColor> Data = {
		Hex(0xc8102e), Hex(0xf2b705), Hex(0x1c8ae8), Hex(0x18b26b),
		Hex(0xf25c05), Hex(0x8c3fd6), Hex(0x0e1116), Hex(0xf5f7fa),
		Hex(0x7c8794), Hex(0x0b4f9e), Hex(0x00e0c6), Hex(0xe8dfd0),
		Hex(0xb8112a), Hex(0x2d3f52), Hex(0xd64ba0), Hex(0x5ee81f),
	};
	return Data;
}

FApexSpec FApexCatalogue::ResolveSpec(const FApexCar& Car, const FApexBuild& Build)
{
	const FApexUpgrades& Up = Build.Upgrades;
	const FApexTune& Tune = Build.Tune;
	const FApexTyreCompound& Tyre = FindTyre(Build.TyreId);

	FApexSpec S;
	S.Car = Car;
	S.Build = Build;
	S.Tyre = Tyre;

	S.Mass = Car.Mass * (1.f - Up.Weight * 0.026f);
	S.PeakTorque = Car.Engine.PeakTorque * (1.f + Up.Engine * 0.06f);
	S.FinalDrive = Car.FinalDrive * (0.82f + Tune.FinalDrive * 0.42f);
	S.Grip = Car.TyreGripBase * Tyre.Grip * (1.f + Up.Tyres * 0.05f);
	S.BrakeStrength = Car.BrakeStrength * (1.f + Up.Brakes * 0.08f);
	S.DownforceCoef = Car.DownforceCoef * (1.f + Up.Aero * 0.18f) * (0.35f + Tune.Downforce * 1.3f);
	S.CdA = Car.CdA * (1.f + Up.Aero * 0.02f + Tune.Downforce * 0.10f);
	S.ShiftTime = Car.ShiftTimeBase * (1.f - Up.Gearbox * 0.14f);
	S.PowerKw = static_cast<float>(EstimatePeakPowerKw(S.PeakTorque, Car.Engine.Redline));

	S.BrakeBias = 0.36f + Tune.BrakeBias * 0.38f;
	S.RideHeight = 0.06f + Tune.RideHeight * 0.10f;
	S.SteerLock = Car.SteerLock * (0.62f + Tune.SteerLock * 0.76f);
	S.ArbFront = Tune.ArbFront;
	S.ArbRear = Tune.ArbRear;
	S.WetGrip = Tyre.WetGrip;
	S.OffroadGrip = Tyre.Offroad + Car.OffroadBonus;

	return S;
}

double FApexCatalogue::EstimatePeakPowerKw(double PeakTorque, double Redline)
{
	double Best = 0.0;
	for (double R = 0.2; R <= 1.0; R += 0.02)
	{
		const double Rpm = R * Redline;
		const double T = PeakTorque * ApexTorqueFactor(R);
		const double Kw = (T * Rpm * 2.0 * PI) / 60.0 / 1000.0;
		Best = FMath::Max(Best, Kw);
	}
	return Best;
}

double FApexCatalogue::EstimateTopSpeed(const FApexSpec& Spec)
{
	const FApexCar& Car = Spec.Car;
	if (Car.Gears.Num() == 0)
	{
		return 40.0;
	}
	const double TopGear = Car.Gears.Last();
	const double R = Car.Body.WheelRadius;
	double Best = 0.0;
	for (double V = 10.0; V < 140.0; V += 0.5)
	{
		const double WheelRpm = (V / R) * (60.0 / (2.0 * PI));
		const double Rpm = WheelRpm * TopGear * Spec.FinalDrive;
		if (Rpm > Car.Engine.Redline * 1.02)
		{
			break;
		}
		const double Tf = ApexTorqueFactor(Rpm / Car.Engine.Redline);
		const double Force = (Spec.PeakTorque * Tf * TopGear * Spec.FinalDrive * Car.DriveEfficiency) / R;
		const double Drag = 0.5 * 1.225 * Spec.CdA * V * V + Spec.Mass * 9.81 * 0.014;
		if (Force <= Drag)
		{
			break;
		}
		Best = V;
	}
	return Best > 0.0 ? Best : 40.0;
}

int32 FApexCatalogue::PerformanceIndex(const FApexSpec& Spec)
{
	const double Pw = Spec.PowerKw / (Spec.Mass / 1000.0);
	const double GripScore = Spec.Grip * 100.0;
	const double AeroScore = FMath::Min<double>(Spec.DownforceCoef, 2.2) * 26.0;
	const double BrakeScore = Spec.BrakeStrength * 190.0;
	const double Raw = Pw * 1.42 + GripScore * 1.55 + AeroScore + BrakeScore;
	return FMath::Clamp(FMath::RoundToInt32(Raw), 100, 999);
}

FString FApexCatalogue::AiName(int32 Index)
{
	static const TCHAR* Names[] = {
		TEXT("R. Vance"), TEXT("M. Okonkwo"), TEXT("L. Bergström"), TEXT("S. Nakamura"),
		TEXT("D. Ferreira"), TEXT("K. Aaltonen"), TEXT("T. Moreau"), TEXT("A. Castellanos"),
		TEXT("J. Whitlock"), TEXT("N. Petrova"), TEXT("C. Delacroix"), TEXT("H. Ishikawa"),
	};
	constexpr int32 Count = UE_ARRAY_COUNT(Names);
	return Names[((Index % Count) + Count) % Count];
}
