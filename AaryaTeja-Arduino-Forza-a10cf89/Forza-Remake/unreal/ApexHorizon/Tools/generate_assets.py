"""
Apex Horizon — asset generation.

Builds the five master materials the game instances at runtime, and an empty level for
it to run in. Everything else — terrain, road, props, cars — is generated in C++ when
the game starts, so this is the only thing in the project that has to touch the editor.

Run it once:

    "/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor-Cmd" \
        <path>/ApexHorizon.uproject \
        -run=pythonscript -script="<path>/Tools/generate_assets.py"

or from the editor's Output Log:  py "<path>/Tools/generate_assets.py"

Re-running replaces the existing assets.
"""

import unreal

MATERIAL_PATH = "/Game/Materials"
MAP_PATH = "/Game/Maps"
MAP_NAME = "ApexHorizon"

MEL = unreal.MaterialEditingLibrary
EAL = unreal.EditorAssetLibrary


# ──────────────────────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────────────────────

def log(message):
    unreal.log("[apex] " + message)


def make_material(name):
    """Create (replacing any existing) an empty material asset."""
    full = "{}/{}".format(MATERIAL_PATH, name)
    if EAL.does_asset_exist(full):
        EAL.delete_asset(full)
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    return tools.create_asset(name, MATERIAL_PATH, unreal.Material, unreal.MaterialFactoryNew())


def expr(material, cls, x=0, y=0):
    return MEL.create_material_expression(material, cls, x, y)


def scalar(material, name, value, x, y):
    node = expr(material, unreal.MaterialExpressionScalarParameter, x, y)
    node.set_editor_property("parameter_name", name)
    node.set_editor_property("default_value", value)
    return node


def vector(material, name, value, x, y):
    node = expr(material, unreal.MaterialExpressionVectorParameter, x, y)
    node.set_editor_property("parameter_name", name)
    node.set_editor_property("default_value", value)
    return node


def constant(material, value, x, y):
    node = expr(material, unreal.MaterialExpressionConstant, x, y)
    node.set_editor_property("r", value)
    return node


def link(material, src, src_pin, dst, dst_pin):
    MEL.connect_material_expressions(src, src_pin, dst, dst_pin)


def output(material, src, src_pin, prop):
    MEL.connect_material_property(src, src_pin, prop)


def world_noise(material, scale, x, y, levels=3):
    """A world-space noise node, used to break up flat procedural surfaces."""
    pos = expr(material, unreal.MaterialExpressionWorldPosition, x - 340, y)
    noise = expr(material, unreal.MaterialExpressionNoise, x, y)
    noise.set_editor_property("scale", scale)
    noise.set_editor_property("levels", levels)
    noise.set_editor_property("output_min", 0.0)
    noise.set_editor_property("output_max", 1.0)
    noise.set_editor_property("turbulence", True)
    link(material, pos, "", noise, "Position")
    return noise


def lerp(material, a, a_pin, b, b_pin, alpha, alpha_pin, x, y):
    node = expr(material, unreal.MaterialExpressionLinearInterpolate, x, y)
    link(material, a, a_pin, node, "A")
    link(material, b, b_pin, node, "B")
    link(material, alpha, alpha_pin, node, "Alpha")
    return node


def multiply(material, a, a_pin, b, b_pin, x, y):
    node = expr(material, unreal.MaterialExpressionMultiply, x, y)
    link(material, a, a_pin, node, "A")
    link(material, b, b_pin, node, "B")
    return node


def add(material, a, a_pin, b, b_pin, x, y):
    node = expr(material, unreal.MaterialExpressionAdd, x, y)
    link(material, a, a_pin, node, "A")
    link(material, b, b_pin, node, "B")
    return node


def finish(material, name):
    MEL.recompile_material(material)
    EAL.save_asset("{}/{}".format(MATERIAL_PATH, name))
    log("built {}".format(name))


# ──────────────────────────────────────────────────────────────────────────────────
# M_ApexSurface — every opaque surface in the world
# ──────────────────────────────────────────────────────────────────────────────────

def build_surface():
    name = "M_ApexSurface"
    m = make_material(name)

    tint = vector(m, "BaseColor", unreal.LinearColor(1.0, 1.0, 1.0, 1.0), -900, -300)
    vcol = expr(m, unreal.MaterialExpressionVertexColor, -900, -60)
    vcol_amount = scalar(m, "VertexColorAmount", 1.0, -900, 140)

    # tint × vertex colour, faded by VertexColorAmount so a material can opt out
    tinted = multiply(m, tint, "", vcol, "RGB", -620, -160)
    base = lerp(m, tint, "", tinted, "", vcol_amount, "", -400, -160)

    # large-scale albedo variation stops big flat areas reading as plastic
    macro = world_noise(m, 0.0016, -900, 400, levels=3)
    macro_amount = scalar(m, "MacroVariation", 0.14, -900, 620)
    macro_scaled = multiply(m, macro, "", macro_amount, "", -620, 480)
    one = constant(m, 1.0, -620, 620)
    macro_gain = add(m, one, "", macro_scaled, "", -440, 520)
    base_varied = multiply(m, base, "", macro_gain, "", -220, 60)
    output(m, base_varied, "", unreal.MaterialProperty.MP_BASE_COLOR)

    # fine noise modulates roughness, which is what sells tarmac and concrete
    rough = scalar(m, "Roughness", 0.7, -900, 860)
    detail = world_noise(m, 0.06, -900, 1080, levels=2)
    detail_amount = scalar(m, "DetailRoughness", 0.18, -900, 1300)
    detail_scaled = multiply(m, detail, "", detail_amount, "", -620, 1140)
    rough_final = add(m, rough, "", detail_scaled, "", -400, 940)
    output(m, rough_final, "", unreal.MaterialProperty.MP_ROUGHNESS)

    output(m, scalar(m, "Metallic", 0.0, -400, 1420), "", unreal.MaterialProperty.MP_METALLIC)
    output(m, scalar(m, "Specular", 0.5, -400, 1560), "", unreal.MaterialProperty.MP_SPECULAR)

    finish(m, name)


# ──────────────────────────────────────────────────────────────────────────────────
# M_ApexCarPaint — clear-coat paint with metallic flake and a pearl shift
# ──────────────────────────────────────────────────────────────────────────────────

def build_car_paint():
    name = "M_ApexCarPaint"
    m = make_material(name)
    m.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_CLEAR_COAT)

    # The clear-coat inputs live on MP_CUSTOMDATA0/1, which Python's MaterialProperty
    # enum does not expose, so the whole surface is routed through a
    # MakeMaterialAttributes node where they are named pins instead.
    attrs = expr(m, unreal.MaterialExpressionMakeMaterialAttributes, 0, 0)
    m.set_editor_property("use_material_attributes", True)

    tint = vector(m, "BaseColor", unreal.LinearColor(0.78, 0.06, 0.11, 1.0), -900, -300)

    # pearl: a fresnel-weighted shift toward a cooler hue at grazing angles
    fres = expr(m, unreal.MaterialExpressionFresnel, -900, -60)
    fres.set_editor_property("exponent", 3.5)
    pearl_amount = scalar(m, "PearlAmount", 0.0, -900, 140)
    pearl_tint = vector(m, "PearlColor", unreal.LinearColor(0.35, 0.55, 0.95, 1.0), -900, 300)
    pearl_weight = multiply(m, fres, "", pearl_amount, "", -640, 40)
    base = lerp(m, tint, "", pearl_tint, "", pearl_weight, "", -400, -160)
    link(m, base, "", attrs, "BaseColor")

    # flake: fine noise lifting roughness so metallic paint sparkles under the sun
    rough = scalar(m, "Roughness", 0.24, -900, 620)
    flake = world_noise(m, 12.0, -900, 840, levels=2)
    flake_amount = scalar(m, "FlakeAmount", 0.6, -900, 1060)
    flake_scaled = multiply(m, flake, "", flake_amount, "", -640, 900)
    flake_gain = multiply(m, flake_scaled, "", constant(m, 0.06, -640, 1060), "", -460, 940)
    rough_final = add(m, rough, "", flake_gain, "", -280, 700)
    link(m, rough_final, "", attrs, "Roughness")

    link(m, scalar(m, "Metallic", 0.85, -400, 1200), "", attrs, "Metallic")
    link(m, constant(m, 0.6, -400, 1320), "", attrs, "Specular")
    link(m, scalar(m, "ClearCoat", 1.0, -400, 1460), "", attrs, "ClearCoat")
    link(m, scalar(m, "ClearCoatRoughness", 0.06, -400, 1600), "", attrs, "ClearCoatRoughness")

    output(m, attrs, "", unreal.MaterialProperty.MP_MATERIAL_ATTRIBUTES)
    finish(m, name)


# ──────────────────────────────────────────────────────────────────────────────────
# M_ApexGlass — tinted, forward-shaded translucency
# ──────────────────────────────────────────────────────────────────────────────────

def build_glass():
    name = "M_ApexGlass"
    m = make_material(name)
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    m.set_editor_property("translucency_lighting_mode",
                          unreal.TranslucencyLightingMode.TLM_SURFACE_PER_PIXEL_LIGHTING)
    m.set_editor_property("two_sided", False)

    output(m, vector(m, "BaseColor", unreal.LinearColor(0.04, 0.05, 0.06, 1.0), -600, -300),
           "", unreal.MaterialProperty.MP_BASE_COLOR)
    output(m, scalar(m, "Roughness", 0.03, -600, -80), "", unreal.MaterialProperty.MP_ROUGHNESS)
    output(m, scalar(m, "Metallic", 0.0, -600, 60), "", unreal.MaterialProperty.MP_METALLIC)
    output(m, scalar(m, "Specular", 1.0, -600, 200), "", unreal.MaterialProperty.MP_SPECULAR)

    # glass gets more opaque at grazing angles, which reads far better than a flat alpha
    fres = expr(m, unreal.MaterialExpressionFresnel, -900, 400)
    fres.set_editor_property("exponent", 2.5)
    opacity = scalar(m, "Opacity", 0.32, -900, 620)
    edge = multiply(m, fres, "", constant(m, 0.6, -900, 760), "", -640, 480)
    opacity_final = add(m, opacity, "", edge, "", -420, 540)
    output(m, opacity_final, "", unreal.MaterialProperty.MP_OPACITY)

    finish(m, name)


# ──────────────────────────────────────────────────────────────────────────────────
# M_ApexWater — the river in the gorge
# ──────────────────────────────────────────────────────────────────────────────────

def build_water():
    name = "M_ApexWater"
    m = make_material(name)
    m.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    m.set_editor_property("translucency_lighting_mode",
                          unreal.TranslucencyLightingMode.TLM_SURFACE_PER_PIXEL_LIGHTING)

    output(m, vector(m, "BaseColor", unreal.LinearColor(0.02, 0.06, 0.09, 1.0), -600, -300),
           "", unreal.MaterialProperty.MP_BASE_COLOR)
    output(m, scalar(m, "Metallic", 0.0, -600, -60), "", unreal.MaterialProperty.MP_METALLIC)
    output(m, scalar(m, "Specular", 1.0, -600, 80), "", unreal.MaterialProperty.MP_SPECULAR)

    # animated ripple: noise sampled against a time-panned world position
    pos = expr(m, unreal.MaterialExpressionWorldPosition, -1200, 420)
    time = expr(m, unreal.MaterialExpressionTime, -1200, 620)
    speed = multiply(m, time, "", constant(m, 22.0, -1200, 760), "", -1000, 660)
    panned = add(m, pos, "", speed, "", -820, 500)
    ripple = expr(m, unreal.MaterialExpressionNoise, -620, 480)
    ripple.set_editor_property("scale", 0.02)
    ripple.set_editor_property("levels", 3)
    ripple.set_editor_property("output_min", 0.0)
    ripple.set_editor_property("output_max", 1.0)
    link(m, panned, "", ripple, "Position")

    rough = scalar(m, "Roughness", 0.02, -620, 720)
    ripple_scaled = multiply(m, ripple, "", constant(m, 0.10, -620, 860), "", -420, 560)
    output(m, add(m, rough, "", ripple_scaled, "", -240, 640), "", unreal.MaterialProperty.MP_ROUGHNESS)

    output(m, scalar(m, "Opacity", 0.80, -600, 1000), "", unreal.MaterialProperty.MP_OPACITY)

    finish(m, name)


# ──────────────────────────────────────────────────────────────────────────────────
# M_ApexEmissive — lamps, light strips, brake discs, rain
# ──────────────────────────────────────────────────────────────────────────────────

def build_emissive():
    name = "M_ApexEmissive"
    m = make_material(name)
    m.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)

    colour = vector(m, "EmissiveColor", unreal.LinearColor(1.0, 0.94, 0.82, 1.0), -700, -200)
    strength = scalar(m, "EmissiveStrength", 10.0, -700, 60)
    output(m, multiply(m, colour, "", strength, "", -420, -120), "",
           unreal.MaterialProperty.MP_EMISSIVE_COLOR)

    finish(m, name)


# ──────────────────────────────────────────────────────────────────────────────────
# the level
# ──────────────────────────────────────────────────────────────────────────────────

def build_level():
    full = "{}/{}".format(MAP_PATH, MAP_NAME)
    subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)

    # The world is generated at runtime, so the level itself is deliberately empty:
    # the game mode spawns the terrain, circuit, sky and every car on BeginPlay.
    subsystem.new_level(full)
    subsystem.save_current_level()
    log("built level {}".format(full))


def main():
    log("generating assets…")
    build_surface()
    build_car_paint()
    build_glass()
    build_water()
    build_emissive()
    build_level()
    log("done — {} materials and one level".format(5))


main()
