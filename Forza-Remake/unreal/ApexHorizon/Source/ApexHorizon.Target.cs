// Apex Horizon — game target.

using UnrealBuildTool;

public class ApexHorizonTarget : TargetRules
{
	public ApexHorizonTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("ApexHorizon");
	}
}
