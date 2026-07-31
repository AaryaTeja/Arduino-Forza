// Apex Horizon — terrain elevation and its renderable/collidable mesh.
//
// The height array is shared between the collision mesh and the rendered mesh, so
// physics and visuals can never disagree. Apex space: metres, X/Z horizontal, Y up.

#pragma once

#include "CoreMinimal.h"

class FApexTrackSpline;
struct FApexMeshData;

/** World layout constants, ported verbatim from the original build. */
namespace ApexWorld
{
	static constexpr double Size = 2400.0;        // metres, square
	static constexpr double Half = 1200.0;
	static constexpr int32  Segments = 300;       // terrain grid resolution (8 m cells)
	static constexpr double WaterLevel = -6.5;

	// river gorge running in from the west edge and petering out inland
	static constexpr double CanyonAx = -1260.0, CanyonAz = 292.0;
	static constexpr double CanyonBx = -120.0, CanyonBz = 486.0;
	static constexpr double CanyonBedY = -13.5, CanyonWidth = 82.0, CanyonTaperFrom = 0.72;

	static constexpr double CityX = 402.0, CityZ = -520.0;
	static constexpr double CityRadius = 330.0, CityFalloff = 260.0, CityFlatY = 11.0;

	static constexpr double MountainStart = 880.0;
	static constexpr double MountainRise = 0.0031;
}

/**
 * Terrain elevation before any road is carved into it. Pure function of XZ.
 * `bWithCanyon = false` skips the gorge so the bridge deck can be laid at grade.
 */
APEXHORIZON_API double ApexBaseHeight(double X, double Z, bool bWithCanyon = true);

class APEXHORIZON_API FApexTerrain
{
public:
	explicit FApexTerrain(const FApexTrackSpline& InSpline);

	static constexpr int32 N = ApexWorld::Segments;

	/** Road-aware elevation: the corridor around the tarmac is levelled to just below it. */
	double Height(double X, double Z) const;

	/** Fill the shared array. Index = ix * (N + 1) + iz. */
	void Build();

	double HeightAtGrid(int32 Ix, int32 Iz) const;

	/** Bilinear sample of the built array — matches the collider exactly. */
	double Sample(double X, double Z) const;

	/**
	 * Emit one tile of the terrain mesh with the ground-cover colour baked into the
	 * vertex colours. Tiles are `TilesPerSide` × `TilesPerSide` over the whole map.
	 */
	void BuildMeshTile(int32 TileX, int32 TileZ, int32 TilesPerSide, FApexMeshData& Out) const;

	/** Water ribbon following the canyon floor. */
	void BuildWater(FApexMeshData& Out) const;

	const TArray<double>& GetHeights() const { return Heights; }

private:
	const FApexTrackSpline& Spline;
	TArray<double> Heights;
};
