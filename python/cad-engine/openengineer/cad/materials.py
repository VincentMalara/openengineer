"""Built-in material properties. Density is kg/m3, stresses and moduli are MPa."""
from ..errors import EngineError

MATERIALS: dict[str, dict] = {
    "steel-1018": {
        "name": "Steel 1018",
        "density_kg_m3": 7870,
        "youngs_modulus_mpa": 205000,
        "poisson": 0.29,
        "yield_mpa": 370,
    },
    "stainless-304": {
        "name": "Stainless steel 304",
        "density_kg_m3": 8000,
        "youngs_modulus_mpa": 193000,
        "poisson": 0.29,
        "yield_mpa": 215,
    },
    "alu-6061": {
        "name": "Aluminium 6061-T6",
        "density_kg_m3": 2700,
        "youngs_modulus_mpa": 68900,
        "poisson": 0.33,
        "yield_mpa": 276,
    },
    "ti-6al-4v": {
        "name": "Titanium Ti-6Al-4V",
        "density_kg_m3": 4430,
        "youngs_modulus_mpa": 113800,
        "poisson": 0.34,
        "yield_mpa": 880,
    },
    "pla": {
        "name": "PLA (3D printed)",
        "density_kg_m3": 1240,
        "youngs_modulus_mpa": 3500,
        "poisson": 0.36,
        "yield_mpa": 50,
    },
    "nylon-pa12": {
        "name": "Nylon PA12 (SLS)",
        "density_kg_m3": 1010,
        "youngs_modulus_mpa": 1700,
        "poisson": 0.40,
        "yield_mpa": 45,
    },
}

DEFAULT_MATERIAL = "steel-1018"


def get_material(material_id: str) -> dict:
    material = MATERIALS.get(material_id)
    if material is None:
        raise EngineError(
            "NOT_FOUND",
            f"Unknown material: {material_id}; available: {', '.join(sorted(MATERIALS))}",
        )
    return {"id": material_id, **material}


def list_materials() -> list[dict]:
    return [{"id": key, **value} for key, value in sorted(MATERIALS.items())]
