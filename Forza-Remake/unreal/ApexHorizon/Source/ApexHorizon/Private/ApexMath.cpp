// Apex Horizon — math helpers that need an out-of-line definition.

#include "ApexMath.h"

namespace ApexMath
{
	FString FormatTime(double Seconds)
	{
		if (!FMath::IsFinite(Seconds) || Seconds < 0.0)
		{
			return TEXT("—");
		}
		const int32 M = FMath::FloorToInt32(Seconds / 60.0);
		const int32 S = FMath::FloorToInt32(Seconds - M * 60.0);
		const int32 Ms = FMath::FloorToInt32((Seconds - M * 60.0 - S) * 1000.0);
		return FString::Printf(TEXT("%d:%02d.%03d"), M, S, Ms);
	}

	FString FormatGap(double Seconds)
	{
		if (!FMath::IsFinite(Seconds))
		{
			return TEXT("—");
		}
		const TCHAR* Sign = Seconds >= 0.0 ? TEXT("+") : TEXT("-");
		const double A = FMath::Abs(Seconds);
		if (A >= 60.0)
		{
			const int32 M = FMath::FloorToInt32(A / 60.0);
			return FString::Printf(TEXT("%s%d:%05.2f"), Sign, M, A - M * 60.0);
		}
		return FString::Printf(TEXT("%s%.3f"), Sign, A);
	}
}
