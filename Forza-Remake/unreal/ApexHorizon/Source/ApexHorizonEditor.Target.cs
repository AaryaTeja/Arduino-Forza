// Apex Horizon — editor target.

using UnrealBuildTool;

public class ApexHorizonEditorTarget : TargetRules
{
	public ApexHorizonEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("ApexHorizon");
	}
}
