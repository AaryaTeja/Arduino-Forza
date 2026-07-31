// Apex Horizon — the surface palette.

#include "ApexMaterialLibrary.h"
#include "ApexHorizon.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"

namespace
{
	FLinearColor Srgb(uint32 Rgb)
	{
		return FLinearColor(FColor(
			static_cast<uint8>((Rgb >> 16) & 0xFF),
			static_cast<uint8>((Rgb >> 8) & 0xFF),
			static_cast<uint8>(Rgb & 0xFF)));
	}
}

UMaterialInterface* UApexMaterialLibrary::LoadMaster(const TCHAR* Path)
{
	UMaterialInterface* M = LoadObject<UMaterialInterface>(nullptr, Path);
	if (!M)
	{
		bUsedFallback = true;
		M = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial"));
	}
	return M;
}

UMaterialInstanceDynamic* UApexMaterialLibrary::MakeSurface(const FLinearColor& Tint, float Roughness,
	float Metallic, float VertexColourAmount, float Specular)
{
	UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(SurfaceMaster, this);
	if (!Mid)
	{
		return nullptr;
	}
	Mid->SetVectorParameterValue("BaseColor", Tint);
	Mid->SetVectorParameterValue("Color", Tint);            // BasicShapeMaterial fallback
	Mid->SetScalarParameterValue("Roughness", Roughness);
	Mid->SetScalarParameterValue("Metallic", Metallic);
	Mid->SetScalarParameterValue("Specular", Specular);
	Mid->SetScalarParameterValue("VertexColorAmount", VertexColourAmount);
	return Mid;
}

void UApexMaterialLibrary::Initialise()
{
	if (Palette.Num() > 0)
	{
		return;
	}

	SurfaceMaster = LoadMaster(TEXT("/Game/Materials/M_ApexSurface.M_ApexSurface"));
	CarPaintMaster = LoadMaster(TEXT("/Game/Materials/M_ApexCarPaint.M_ApexCarPaint"));
	GlassMaster = LoadMaster(TEXT("/Game/Materials/M_ApexGlass.M_ApexGlass"));
	WaterMaster = LoadMaster(TEXT("/Game/Materials/M_ApexWater.M_ApexWater"));
	EmissiveMaster = LoadMaster(TEXT("/Game/Materials/M_ApexEmissive.M_ApexEmissive"));

	if (bUsedFallback)
	{
		UE_LOG(LogApex, Warning,
			TEXT("Generated master materials not found — falling back to engine materials. ")
			TEXT("Run Tools/generate_assets.py once in the editor to build them."));
	}

	auto Add = [this](FName Key, UMaterialInterface* M)
	{
		if (M)
		{
			Palette.Add(Key, M);
		}
	};

	// ── driving surfaces ──────────────────────────────────────────────────────────
	Add("road", MakeSurface(Srgb(0x2a2c30), 0.62f, 0.f, 0.f, 0.35f));
	Add("kerb", MakeSurface(FLinearColor::White, 0.55f, 0.f, 0.f));
	Add("sidewalk", MakeSurface(Srgb(0x9a9a96), 0.80f, 0.f, 0.f));
	Add("startLine", MakeSurface(Srgb(0xf2f4f7), 0.48f, 0.f, 0.f));
	Add("terrain", MakeSurface(FLinearColor::White, 0.92f, 0.f, 1.f, 0.25f));

	// ── structures ────────────────────────────────────────────────────────────────
	Add("concrete", MakeSurface(Srgb(0x8e8e90), 0.86f, 0.f, 0.6f));
	Add("barrierMetal", MakeSurface(Srgb(0xb9bdc4), 0.34f, 0.9f, 0.f));
	Add("metalPole", MakeSurface(Srgb(0x5c6066), 0.45f, 0.85f, 0.6f));
	Add("steel", MakeSurface(Srgb(0xa8adb5), 0.38f, 0.92f, 0.6f));
	Add("tunnelWall", MakeSurface(Srgb(0xa0a09a), 0.72f, 0.f, 0.6f));
	Add("portal", MakeSurface(Srgb(0x78766f), 0.82f, 0.f, 0.6f));
	Add("rockFace", MakeSurface(Srgb(0x6e6a62), 0.95f, 0.f, 0.8f));
	Add("marker", MakeSurface(FLinearColor::White, 0.55f, 0.f, 1.f));
	Add("fence", MakeSurface(Srgb(0x60503c), 0.90f, 0.f, 0.8f));

	// ── city ──────────────────────────────────────────────────────────────────────
	Add("facadeA", MakeSurface(Srgb(0x7d838c), 0.42f, 0.15f, 0.8f, 0.6f));
	Add("facadeB", MakeSurface(Srgb(0x5f6a78), 0.30f, 0.25f, 0.8f, 0.7f));
	Add("facadeC", MakeSurface(Srgb(0x8d8579), 0.55f, 0.05f, 0.8f, 0.5f));

	// ── vegetation ────────────────────────────────────────────────────────────────
	Add("bark", MakeSurface(FLinearColor::White, 0.94f, 0.f, 1.f, 0.2f));
	Add("leafBroad", MakeSurface(FLinearColor::White, 0.78f, 0.f, 1.f, 0.25f));
	Add("leafConifer", MakeSurface(FLinearColor::White, 0.80f, 0.f, 1.f, 0.25f));
	Add("bush", MakeSurface(FLinearColor::White, 0.85f, 0.f, 1.f, 0.2f));
	Add("rock", MakeSurface(FLinearColor::White, 0.92f, 0.f, 1.f, 0.3f));

	// ── vehicle ───────────────────────────────────────────────────────────────────
	Add("tyre", MakeSurface(Srgb(0x1a1b1d), 0.88f, 0.f, 0.f, 0.3f));
	Add("rim", MakeSurface(Srgb(0xc4c9d0), 0.22f, 1.f, 0.f));
	Add("caliper", MakeSurface(Srgb(0xd03020), 0.40f, 0.3f, 0.f));
	Add("carTrim", MakeSurface(Srgb(0x141619), 0.45f, 0.4f, 0.f));

	// ── emissive ──────────────────────────────────────────────────────────────────
	if (UMaterialInstanceDynamic* Lamp = CreateEmissive(Srgb(0xfff0d0), 30.f)) { Palette.Add("lampHead", Lamp); }
	if (UMaterialInstanceDynamic* Strip = CreateEmissive(Srgb(0xffe9c0), 22.f)) { Palette.Add("tunnelLight", Strip); }
	if (UMaterialInstanceDynamic* Banner = CreateEmissive(Srgb(0x29e0a8), 6.f)) { Palette.Add("banner", Banner); }
	if (UMaterialInstanceDynamic* Gate = CreateEmissive(Srgb(0x29e0a8), 12.f)) { Palette.Add("checkpoint", Gate); }

	// ── water ─────────────────────────────────────────────────────────────────────
	if (UMaterialInstanceDynamic* Water = UMaterialInstanceDynamic::Create(WaterMaster, this))
	{
		Water->SetVectorParameterValue("BaseColor", Srgb(0x0d2a3a));
		Water->SetVectorParameterValue("Color", Srgb(0x0d2a3a));
		Water->SetScalarParameterValue("Roughness", 0.04f);
		Palette.Add("water", Water);
	}

	// ── glass ─────────────────────────────────────────────────────────────────────
	if (UMaterialInstanceDynamic* G = UMaterialInstanceDynamic::Create(GlassMaster, this))
	{
		G->SetVectorParameterValue("BaseColor", FLinearColor(0.04f, 0.05f, 0.06f));
		G->SetVectorParameterValue("Color", FLinearColor(0.04f, 0.05f, 0.06f));
		G->SetScalarParameterValue("Roughness", 0.03f);
		Glass = G;
		Palette.Add("glass", G);
	}
}

UMaterialInterface* UApexMaterialLibrary::Get(FName Key)
{
	if (TObjectPtr<UMaterialInterface>* Found = Palette.Find(Key))
	{
		return *Found;
	}
	// Unknown key: a neutral surface is better than a missing-material checkerboard.
	UMaterialInterface* Neutral = MakeSurface(FLinearColor(0.5f, 0.5f, 0.5f), 0.7f, 0.f, 1.f);
	Palette.Add(Key, Neutral);
	return Neutral;
}

UMaterialInstanceDynamic* UApexMaterialLibrary::CreateCarPaint(const FLinearColor& Colour, int32 Finish, bool bStripes)
{
	UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(CarPaintMaster, this);
	if (!Mid)
	{
		return nullptr;
	}

	// 0 gloss, 1 metallic, 2 pearl, 3 matte
	float Metallic = 0.f, Roughness = 0.22f, ClearCoat = 1.f, Flake = 0.f, Pearl = 0.f;
	switch (Finish)
	{
	case 1: Metallic = 0.85f; Roughness = 0.26f; Flake = 0.6f; break;
	case 2: Metallic = 0.4f;  Roughness = 0.20f; Flake = 0.35f; Pearl = 1.f; break;
	case 3: Metallic = 0.f;   Roughness = 0.72f; ClearCoat = 0.05f; break;
	default: break;
	}

	Mid->SetVectorParameterValue("BaseColor", Colour);
	Mid->SetVectorParameterValue("Color", Colour);
	Mid->SetScalarParameterValue("Metallic", Metallic);
	Mid->SetScalarParameterValue("Roughness", Roughness);
	Mid->SetScalarParameterValue("ClearCoat", ClearCoat);
	Mid->SetScalarParameterValue("ClearCoatRoughness", 0.06f);
	Mid->SetScalarParameterValue("FlakeAmount", Flake);
	Mid->SetScalarParameterValue("PearlAmount", Pearl);
	Mid->SetScalarParameterValue("StripeAmount", bStripes ? 1.f : 0.f);
	return Mid;
}

UMaterialInstanceDynamic* UApexMaterialLibrary::CreateEmissive(const FLinearColor& Colour, float Strength)
{
	UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(EmissiveMaster, this);
	if (!Mid)
	{
		return nullptr;
	}
	Mid->SetVectorParameterValue("EmissiveColor", Colour);
	Mid->SetVectorParameterValue("Color", Colour);
	Mid->SetScalarParameterValue("EmissiveStrength", Strength);
	return Mid;
}
