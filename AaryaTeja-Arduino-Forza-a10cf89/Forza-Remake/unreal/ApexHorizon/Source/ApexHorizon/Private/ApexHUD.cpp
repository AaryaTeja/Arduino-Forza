// Apex Horizon — canvas HUD: tacho, race info, standings, minimap and banner.

#include "ApexGameMode.h"

#include "ApexAIDriver.h"
#include "ApexMath.h"
#include "ApexTrackSpline.h"
#include "ApexVehiclePawn.h"
#include "ApexWorldActor.h"

#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Kismet/GameplayStatics.h"

using namespace ApexMath;

namespace
{
	const FLinearColor Ink(0.92f, 0.95f, 0.98f);
	const FLinearColor Dim(0.62f, 0.67f, 0.74f);
	const FLinearColor Accent(0.16f, 0.88f, 0.66f);
	const FLinearColor Warn(0.98f, 0.29f, 0.24f);
	const FLinearColor Gold(1.f, 0.79f, 0.29f);
}

void AApexHUD::Panel(float X, float Y, float W, float H, float Alpha)
{
	DrawRect(FLinearColor(0.02f, 0.03f, 0.05f, Alpha), X, Y, W, H);
}

void AApexHUD::Label(const FString& Text, float X, float Y, const FLinearColor& Colour, float Scale, bool bLarge)
{
	UFont* Font = bLarge ? GEngine->GetLargeFont() : GEngine->GetMediumFont();
	DrawText(Text, Colour, X, Y, Font, Scale, false);
}

void AApexHUD::DrawTachometer(const FApexTelemetry& T, const FApexSpec& Spec, float X, float Y, float Radius)
{
	constexpr int32 Segments = 56;
	constexpr float StartAngle = 140.f;
	constexpr float SweepAngle = 260.f;

	const float Redline = FMath::Max(Spec.Car.Engine.Redline, 1.f);
	const float RpmFrac = FMath::Clamp(T.Rpm / Redline, 0.f, 1.f);

	for (int32 i = 0; i < Segments; ++i)
	{
		const float F0 = static_cast<float>(i) / Segments;
		const float A = FMath::DegreesToRadians(StartAngle + F0 * SweepAngle);
		const float Cos = FMath::Cos(A), Sin = FMath::Sin(A);

		const bool bLit = F0 <= RpmFrac;
		const bool bDanger = F0 > 0.88f;
		const float Inner = Radius * (bLit ? 0.74f : 0.80f);

		FLinearColor Colour = Dim * 0.55f;
		if (bLit)
		{
			Colour = bDanger ? Warn : FMath::Lerp(Accent, Gold, F0);
		}
		else if (bDanger)
		{
			Colour = Warn * 0.30f;
		}
		Colour.A = 1.f;

		DrawLine(X + Cos * Inner, Y + Sin * Inner, X + Cos * Radius, Y + Sin * Radius, Colour, bLit ? 4.f : 2.f);
	}

	const int32 Kmh = FMath::RoundToInt32(FMath::Abs(T.Speed) * 3.6f);
	const FString SpeedText = FString::FromInt(Kmh);
	Label(SpeedText, X - SpeedText.Len() * 9.f, Y - 22.f, Ink, 1.8f, true);
	Label(TEXT("km/h"), X - 18.f, Y + 16.f, Dim, 0.9f);

	FString GearText = TEXT("N");
	if (T.Gear > 0) { GearText = FString::FromInt(T.Gear); }
	else if (T.Gear < 0) { GearText = TEXT("R"); }
	Label(GearText, X + Radius * 0.66f, Y + Radius * 0.42f, Gold, 1.8f, true);

	Label(FString::Printf(TEXT("%d rpm"), FMath::RoundToInt32(T.Rpm)), X - 34.f, Y + 38.f, Dim, 0.85f);
}

void AApexHUD::DrawRaceInfo(AApexGameMode* GameMode, float Width, float Height)
{
	AApexRaceDirector* Race = GameMode->GetRaceDirector();
	const FApexEntrant* P = Race->GetPlayer();
	if (!P)
	{
		return;
	}

	Panel(24.f, 24.f, 280.f, 128.f);

	const int32 ShownLap = FMath::Min(P->Lap + 1, Race->GetLaps());
	if (Race->GetMode() == EApexRaceMode::FreeRoam)
	{
		Label(TEXT("FREE ROAM"), 42.f, 40.f, Accent, 1.1f);
	}
	else
	{
		Label(FString::Printf(TEXT("LAP  %d / %d"), ShownLap, Race->GetLaps()), 42.f, 38.f, Ink, 1.2f);
		Label(FString::Printf(TEXT("P%d  of %d"), P->Position, Race->GetEntrants().Num()),
			42.f, 66.f, Gold, 1.2f);
	}

	Label(FString::Printf(TEXT("TIME   %s"), *FormatTime(Race->GetTime())), 42.f, 96.f, Dim, 0.95f);
	Label(FString::Printf(TEXT("BEST   %s"), *FormatTime(P->BestLap)), 42.f, 118.f, Dim, 0.95f);

	if (P->bWrongWay)
	{
		Label(TEXT("WRONG WAY"), Width * 0.5f - 70.f, Height * 0.32f, Warn, 1.6f, true);
	}
}

void AApexHUD::DrawStandings(AApexRaceDirector* Race, float Width, float Height)
{
	if (Race->GetMode() == EApexRaceMode::FreeRoam)
	{
		return;
	}

	const TArray<int32>& Order = Race->GetStandings();
	const TArray<FApexEntrant>& Entrants = Race->GetEntrants();
	const int32 Rows = FMath::Min(Order.Num(), 10);
	if (Rows == 0)
	{
		return;
	}

	constexpr float RowH = 21.f;
	const float PanelW = 250.f;
	const float X = Width - PanelW - 24.f;
	const float Y = 24.f;

	Panel(X, Y, PanelW, RowH * Rows + 16.f);

	for (int32 i = 0; i < Rows; ++i)
	{
		const FApexEntrant& E = Entrants[Order[i]];
		const float RowY = Y + 10.f + i * RowH;

		// livery swatch, so the field is readable at a glance
		DrawRect(E.Colour, X + 8.f, RowY + 4.f, 5.f, 13.f);

		const FLinearColor Colour = E.bIsPlayer ? Gold : Ink;
		Label(FString::Printf(TEXT("%d"), i + 1), X + 20.f, RowY, Colour, 0.9f);
		Label(E.Name, X + 44.f, RowY, Colour, 0.9f);

		FString Right;
		if (E.bFinished)
		{
			Right = TEXT("FIN");
		}
		else if (i == 0)
		{
			Right = TEXT("—");
		}
		else
		{
			Right = FormatGap(E.GapToLeader);
		}
		Label(Right, X + PanelW - 68.f, RowY, i == 0 ? Accent : Dim, 0.9f);
	}
}

void AApexHUD::DrawMinimap(AApexGameMode* GameMode, float X, float Y, float Size)
{
	AApexWorldActor* World = GameMode->GetWorldActor();
	AApexRaceDirector* Race = GameMode->GetRaceDirector();
	if (!World || !World->IsBuilt())
	{
		return;
	}

	Panel(X, Y, Size, Size, 0.45f);

	const FApexTrackSpline& Sp = World->GetSpline();

	// fit the circuit into the panel
	double MinX = TNumericLimits<double>::Max(), MaxX = -TNumericLimits<double>::Max();
	double MinZ = TNumericLimits<double>::Max(), MaxZ = -TNumericLimits<double>::Max();
	for (int32 i = 0; i < Sp.Count; ++i)
	{
		MinX = FMath::Min(MinX, Sp.X[i]); MaxX = FMath::Max(MaxX, Sp.X[i]);
		MinZ = FMath::Min(MinZ, Sp.Z[i]); MaxZ = FMath::Max(MaxZ, Sp.Z[i]);
	}
	const double Span = FMath::Max(MaxX - MinX, MaxZ - MinZ);
	if (Span <= 0.0)
	{
		return;
	}

	constexpr double Pad = 14.0;
	const double Scale = (Size - Pad * 2.0) / Span;
	const double Ox = X + Pad + ((Span - (MaxX - MinX)) * 0.5) * Scale;
	const double Oy = Y + Pad + ((Span - (MaxZ - MinZ)) * 0.5) * Scale;

	auto ToScreen = [&](double Wx, double Wz, float& Sx, float& Sy)
	{
		Sx = static_cast<float>(Ox + (Wx - MinX) * Scale);
		Sy = static_cast<float>(Oy + (Wz - MinZ) * Scale);
	};

	// the circuit, drawn every few samples to keep the line count sane
	constexpr int32 Stride = 3;
	float Px = 0.f, Py = 0.f;
	ToScreen(Sp.X[0], Sp.Z[0], Px, Py);
	for (int32 i = Stride; i <= Sp.Count; i += Stride)
	{
		const int32 J = i % Sp.Count;
		float Cx, Cy;
		ToScreen(Sp.X[J], Sp.Z[J], Cx, Cy);
		DrawLine(Px, Py, Cx, Cy, FLinearColor(0.55f, 0.60f, 0.68f, 0.9f), 2.f);
		Px = Cx; Py = Cy;
	}

	// start line
	{
		float Sx, Sy;
		ToScreen(Sp.X[World->GetStartIndex()], Sp.Z[World->GetStartIndex()], Sx, Sy);
		DrawRect(Ink, Sx - 3.f, Sy - 3.f, 6.f, 6.f);
	}

	// cars
	for (const FApexEntrant& E : Race->GetEntrants())
	{
		if (!E.Pawn)
		{
			continue;
		}
		double Wx, Wy, Wz;
		UEToApex(E.Pawn->GetActorLocation(), Wx, Wy, Wz);
		float Sx, Sy;
		ToScreen(Wx, Wz, Sx, Sy);

		const float R = E.bIsPlayer ? 5.f : 3.5f;
		DrawRect(E.bIsPlayer ? Gold : E.Colour, Sx - R, Sy - R, R * 2.f, R * 2.f);
	}
}

void AApexHUD::DrawBanner(AApexGameMode* GameMode, float Width, float Height)
{
	if (GameMode->GetBannerTimeLeft() <= 0.f || GameMode->GetBannerText().IsEmpty())
	{
		return;
	}

	const FString& Text = GameMode->GetBannerText();
	const float Fade = FMath::Clamp(GameMode->GetBannerTimeLeft(), 0.f, 1.f);
	FLinearColor Colour = Text == TEXT("GO") ? Accent : Ink;
	Colour.A = Fade;

	const float Scale = Text.Len() <= 2 ? 4.5f : 2.2f;
	const float TextWidth = Text.Len() * 13.f * Scale * 0.5f;
	Label(Text, Width * 0.5f - TextWidth * 0.5f, Height * 0.30f, Colour, Scale, true);
}

void AApexHUD::DrawHUD()
{
	Super::DrawHUD();

	if (!Canvas)
	{
		return;
	}

	AApexGameMode* GameMode = Cast<AApexGameMode>(UGameplayStatics::GetGameMode(this));
	if (!GameMode || !GameMode->GetRaceDirector() || !GameMode->GetPlayerVehicle())
	{
		return;
	}

	const float Width = Canvas->ClipX;
	const float Height = Canvas->ClipY;
	AApexVehiclePawn* Vehicle = GameMode->GetPlayerVehicle();

	DrawTachometer(Vehicle->GetTelemetry(), Vehicle->GetSpec(),
		Width - 150.f, Height - 150.f, 108.f);

	DrawRaceInfo(GameMode, Width, Height);
	DrawStandings(GameMode->GetRaceDirector(), Width, Height);
	DrawMinimap(GameMode, 24.f, Height - 224.f, 200.f);
	DrawBanner(GameMode, Width, Height);

	// car name, bottom centre
	Label(Vehicle->GetSpec().Car.Name, 24.f, Height - 250.f, Dim, 1.f);
}
