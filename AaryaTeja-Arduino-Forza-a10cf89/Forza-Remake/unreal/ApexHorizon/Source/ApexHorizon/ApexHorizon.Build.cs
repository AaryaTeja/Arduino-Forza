// Apex Horizon — module rules.

using UnrealBuildTool;

public class ApexHorizon : ModuleRules
{
	public ApexHorizon(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore",
			"EnhancedInput",
			"PhysicsCore",
			"ChaosVehicles",
			"ChaosVehiclesCore",
			"ProceduralMeshComponent",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"RenderCore",
			"RHI",
			"Slate",
			"SlateCore",
			"UMG",
		});

		// The Chaos vehicle headers expose Chaos::FSimple*Config types inline, so this
		// module needs the same physics setup the ChaosVehicles module itself uses.
		SetupModulePhysicsSupport(Target);
		PrivateDefinitions.Add("CHAOS_INCLUDE_LEVEL_1=1");
	}
}
