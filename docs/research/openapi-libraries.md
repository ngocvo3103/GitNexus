# OpenAPI Specification Libraries for Python

## Research Summary

This document covers OpenAPI 3.x specification formats and Python libraries for generating OpenAPI specs programmatically.

---

## 1. OpenAPI 3.x Specification Structure

### Format Overview

OpenAPI specifications can be written in **either JSON or YAML** (YAML 1.2 recommended). Both formats represent the same JSON object structure - all JSON is valid YAML.

### Minimal OpenAPI 3.1 Document

**YAML Format:**
```yaml
openapi: 3.1.0
info:
  title: API Title
  version: 1.0.0
paths: {}
```

**JSON Format:**
```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "API Title",
    "version": "1.0.0"
  },
  "paths": {}
}
```

### Root Object Fields (OpenAPI 3.1)

| Field | Required | Description |
|-------|----------|-------------|
| `openapi` | Yes | Version string (e.g., "3.1.0") |
| `info` | Yes | API metadata (title, version, description, contact, license) |
| `jsonSchemaDialect` | No | Default JSON Schema dialect for schemas |
| `servers` | No | Array of server objects with URLs |
| `paths` | No* | Map of paths to Path Item Objects |
| `webhooks` | No | Map of webhook definitions (new in 3.1) |
| `components` | No* | Reusable schemas, parameters, responses |
| `security` | No | Global security requirements |
| `tags` | No | Tag metadata for grouping |
| `externalDocs` | No | External documentation links |

*At least one of `paths`, `components`, or `webhooks` is required.

### Key Changes in OpenAPI 3.1 vs 3.0

- **Full JSON Schema 2020-12 compatibility**
- `nullable` replaced with `type: ["string", "null"]`
- `example` replaced with `examples` array
- New `webhooks` top-level field
- PathItems can be defined in `components`

---

## 2. Python Libraries for OpenAPI Generation

### 2.1 apispec (v6.10.0)

**Status:** Production/Stable | **Downloads:** 15M+/month | **Python:** >=3.10

**Installation:**
```bash
pip install -U apispec
pip install -U apispec[marshmallow]  # For marshmallow integration
```

**Overview:**
Framework-agnostic OpenAPI spec generator. Built-in marshmallow support, plugin architecture for extensibility.

**Example Usage:**
```python
from apispec import APISpec
from apispec.ext.marshmallow import MarshmallowPlugin
from marshmallow import Schema, fields

# Define schema
class PetSchema(Schema):
    id = fields.Int(dump_only=True)
    name = fields.Str(required=True)
    category = fields.Str()

# Initialize spec
spec = APISpec(
    title="Pet Store API",
    version="1.0.0",
    openapi_version="3.0.2",
    plugins=[MarshmallowPlugin()],
)

# Register schema
spec.components.schema("Pet", schema=PetSchema)

# Add path
spec.path(
    path="/pets",
    operations={
        "get": {
            "responses": {
                "200": {
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Pet"}
                        }
                    }
                }
            }
        }
    }
)

# Export
spec.to_dict()   # Python dict
spec.to_yaml()   # YAML string
```

**Pros:**
- Most battle-tested and widely adopted
- Framework-agnostic design
- Extensible plugin system
- Built-in marshmallow integration
- Supports OpenAPI 2.x and 3.x

**Cons:**
- Dictionary-based API (less type-safe)
- Requires marshmallow for schema generation
- More verbose than Pydantic alternatives

---

### 2.2 openapi-pydantic (v0.5.1)

**Status:** Active | **Python:** 3.8+ | **Pydantic:** 1.8+ or 2.x

**Installation:**
```bash
pip install openapi-pydantic
```

**Overview:**
Type-safe Pydantic models for OpenAPI schemas. Supports OpenAPI 3.0 and 3.1.

**Example Usage:**
```python
from pydantic import BaseModel, Field
from openapi_pydantic import OpenAPI, Info, PathItem, Operation, Response
from openapi_pydantic.util import PydanticSchema, construct_open_api_with_schema_class

# Define Pydantic models
class PetRequest(BaseModel):
    """Pet creation request"""
    name: str = Field(..., description="Pet name")
    category: str = Field(None, description="Pet category")

class PetResponse(BaseModel):
    """Pet response"""
    id: int = Field(..., description="Pet ID")
    name: str = Field(..., description="Pet name")
    category: str = Field(None, description="Pet category")

# Build OpenAPI spec
open_api = OpenAPI.model_validate({
    "info": {"title": "Pet Store API", "version": "1.0.0"},
    "paths": {
        "/pets": {
            "post": {
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": PydanticSchema(schema_class=PetRequest)
                        }
                    }
                },
                "responses": {
                    "201": {
                        "description": "Created",
                        "content": {
                            "application/json": {
                                "schema": PydanticSchema(schema_class=PetResponse)
                            }
                        }
                    }
                }
            }
        }
    }
})

# Resolve Pydantic schemas into $ref components
open_api = construct_open_api_with_schema_class(open_api)

# Export JSON (CRITICAL: use these parameters!)
json_str = open_api.model_dump_json(by_alias=True, exclude_none=True, indent=2)
```

**For OpenAPI 3.0 (Swagger UI compatible):**
```python
from openapi_pydantic.v3.v3_0 import OpenAPI
from openapi_pydantic.v3.v3_0.util import PydanticSchema, construct_open_api_with_schema_class
```

**Pros:**
- Full type safety with Pydantic models
- IDE autocomplete and validation
- Supports OpenAPI 3.1 (latest)
- Works with Pydantic v1 and v2
- Cleaner code with model classes

**Cons:**
- Newer library (less mature)
- Requires Pydantic knowledge
- Different import paths for 3.0 vs 3.1

---

### 2.3 flask-apispec (v0.11.4)

**Status:** Active | **Python:** 3.7+

**Installation:**
```bash
pip install flask-apispec
```

**Overview:**
Flask extension combining flask-apispec with webargs and marshmallow for automatic OpenAPI generation from Flask views.

**Example Usage:**
```python
from flask import Flask
from flask_apispec import use_kwargs, marshal_with, doc
from flask_apispec.views import MethodResource
from flask_apispec.extension import FlaskApiSpec
from marshmallow import Schema, fields
from apispec import APISpec
from apispec.ext.marshmallow import MarshmallowPlugin

app = Flask(__name__)

# Define schemas
class PetSchema(Schema):
    id = fields.Int(dump_only=True)
    name = fields.Str(required=True)
    category = fields.Str()

# Configure OpenAPI
app.config.update({
    'APISPEC_SPEC': APISpec(
        title='Pet Store API',
        version='v1',
        plugins=[MarshmallowPlugin()],
    ),
    'APISPEC_SWAGGER_URL': '/swagger/',
})

docs = FlaskApiSpec(app)

# Function-based view
@app.route('/pets')
@use_kwargs({'category': fields.Str()}, location='query')
@marshal_with(PetSchema(many=True))
@doc(tags=['pets'])
def get_pets(**kwargs):
    return Pet.query.filter_by(**kwargs)

# Class-based view
@marshal_with(PetSchema)
class PetResource(MethodResource):
    def get(self, pet_id):
        return Pet.query.filter_by(id=pet_id).one()

    @use_kwargs(PetSchema)
    def post(self, **kwargs):
        pet = Pet(**kwargs)
        return pet, 201

docs.register(get_pets)
docs.register(PetResource)
```

**Endpoints Generated:**
- `/swagger/` - Swagger JSON
- `/swagger-ui/` - Swagger UI

**Pros:**
- Automatic spec generation from Flask routes
- Decorator-based API (clean code)
- Works with Flask-RESTful
- Built-in request validation via webargs

**Cons:**
- Flask-specific
- Requires marshmallow
- Less control over spec structure

---

### 2.4 FastAPI (Built-in)

**Status:** Production | **Python:** 3.8+

**Installation:**
```bash
pip install fastapi uvicorn
```

**Overview:**
FastAPI generates OpenAPI specs automatically from route definitions and Pydantic models. No additional libraries needed.

**Example Usage:**
```python
from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Optional

app = FastAPI(
    title="Pet Store API",
    description="A **pet store** management API",
    version="1.0.0",
    contact={"name": "Support", "email": "support@example.com"},
)

class Pet(BaseModel):
    id: int = Field(..., description="Pet ID")
    name: str = Field(..., description="Pet name", examples=["Fido"])
    category: Optional[str] = Field(None, description="Pet category")

class PetCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    category: Optional[str] = None

@app.get("/pets", response_model=list[Pet], tags=["pets"])
async def list_pets(category: Optional[str] = None):
    """List all pets with optional filtering."""
    return [{"id": 1, "name": "Fido", "category": category or "dog"}]

@app.post("/pets", response_model=Pet, status_code=201, tags=["pets"])
async def create_pet(pet: PetCreate):
    """Create a new pet."""
    return {"id": 1, **pet.model_dump()}
```

**Access Generated Spec:**
- OpenAPI JSON: `/openapi.json`
- Swagger UI: `/docs`
- ReDoc: `/redoc`

**Export Spec Programmatically:**
```python
import json
import yaml

# Get the spec
spec = app.openapi()

# Export as JSON
json_spec = json.dumps(spec, indent=2)

# Export as YAML (requires PyYAML)
yaml_spec = yaml.dump(spec, sort_keys=False)
```

**Pros:**
- Zero configuration needed
- Automatic from Pydantic models
- Type-safe throughout
- Built-in validation
- Modern async support

**Cons:**
- Tied to FastAPI framework
- Customization requires overriding `openapi()` method

---

## 3. YAML/JSON Conversion Libraries

### 3.1 PyYAML + json (Standard Library)

**Installation:**
```bash
pip install pyyaml
```

**Example:**
```python
import yaml
import json

# YAML to JSON
def yaml_to_json(yaml_path: str) -> str:
    with open(yaml_path, 'r') as f:
        data = yaml.safe_load(f)
    return json.dumps(data, indent=2)

# JSON to YAML
def json_to_yaml(json_path: str) -> str:
    with open(json_path, 'r') as f:
        data = json.load(f)
    return yaml.dump(data, default_flow_style=False, sort_keys=False)
```

### 3.2 ruamel.yaml

**Installation:**
```bash
pip install ruamel.yaml
```

**Example:**
```python
from ruamel.yaml import YAML

yaml = YAML()
yaml.preserve_quotes = True
yaml.indent(mapping=2, sequence=4, offset=2)

# Read with formatting preservation
with open('openapi.yaml', 'r') as f:
    data = yaml.load(f)

# Write back (preserves comments)
with open('openapi.yaml', 'w') as f:
    yaml.dump(data, f)
```

**Pros over PyYAML:**
- YAML 1.2 compliant
- Preserves comments in roundtrip mode
- Better formatting control

### 3.3 jentic-openapi-parser (v1.0.0a42)

**Installation:**
```bash
pip install jentic-openapi-parser
```

**Features:**
- Pluggable backends (PyYAML, ruamel.yaml)
- Parse from file URIs or strings
- Source tracking (line/column)
- OpenAPI version detection (3.0/3.1)
- Roundtrip mode preserves comments

---

## 4. Best Practices for OpenAPI Generation

### 4.1 General Guidelines

1. **Start with versioning** - Use `/v1` prefix from the beginning
2. **Lock response shapes** - Use `response_model` to prevent breaking changes
3. **Document errors** - Include all error responses (400, 401, 403, 404, 422, 500)
4. **Use examples** - Add request/response examples
5. **Tag consistently** - Group endpoints with meaningful tags

### 4.2 Error Response Pattern

```python
class Error(BaseModel):
    code: str = Field(..., description="Machine-readable error code")
    message: str = Field(..., description="Human-readable message")
    detail: Optional[dict] = Field(None, description="Structured details")

@app.get("/items/{id}", responses={
    404: {"model": Error, "description": "Item not found"},
    500: {"model": Error, "description": "Internal error"}
})
```

### 4.3 Pagination Pattern

```python
from pydantic import BaseModel
from typing import Generic, TypeVar, Optional

T = TypeVar('T')

class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T]
    meta: dict = {"total": 0, "offset": 0, "limit": 20}

@app.get("/items")
async def list_items(
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100)
):
    return {"items": [], "meta": {"total": 0, "offset": offset, "limit": limit}}
```

### 4.4 CI/CD Integration

```yaml
# .github/workflows/openapi-validate.yml
- name: Validate OpenAPI Spec
  run: |
    pip install openapi-spec-validator
    openapi-spec-validator openapi.yaml
```

---

## 5. Library Comparison Matrix

| Feature | apispec | openapi-pydantic | flask-apispec | FastAPI |
|---------|---------|-------------------|---------------|--------|
| **Type Safety** | Low (dict) | High (Pydantic) | Medium | High |
| **Framework** | Agnostic | Agnostic | Flask | FastAPI |
| **Schema Lib** | marshmallow | Pydantic | marshmallow | Pydantic |
| **OpenAPI 3.1** | Yes | Yes | Yes | Yes |
| **Auto-generation** | No | No | Yes | Yes |
| **Learning Curve** | Low | Medium | Low | Medium |
| **Maturity** | High | Medium | Medium | High |

---

## 6. Recommendations

### For New Projects (FastAPI-based)
**Use FastAPI's built-in OpenAPI generation.** It provides:
- Automatic spec from route definitions
- Type safety with Pydantic
- Zero configuration
- Built-in Swagger UI and ReDoc

### For Flask Projects
**Use flask-apispec** if you want automatic generation from routes, or **apispec** for more control over the spec structure.

### For Framework-Agnostic Generation
- **openapi-pydantic** for type-safe, modern code with Pydantic
- **apispec** for mature, marshmallow-based workflows

### For YAML/JSON Conversion
- **PyYAML + json** for simple use cases
- **ruamel.yaml** when preserving comments/formatting matters

---

## Sources

- [apispec Documentation](https://apispec.readthedocs.io/en/stable) - Official apispec docs
- [apispec PyPI](https://pypi.org/project/apispec/) - Installation and basic usage
- [openapi-pydantic PyPI](https://pypi.org/project/openapi-pydantic/) - Library reference
- [openapi-pydantic GitHub](https://github.com/mike-oakley/openapi-pydantic) - Source and examples
- [Speakeasy Pydantic Guide](https://speakeasy.com/openapi/frameworks/pydantic) - Pydantic v2 OpenAPI generation
- [flask-apispec Documentation](https://flask-apispec.readthedocs.io/en/stable/) - Flask integration guide
- [flask-apispec PyPI](https://pypi.org/project/flask-apispec/) - Installation
- [OpenAPI 3.1.1 Specification](https://spec.openapis.org/oas/v3.1.1.html) - Official spec reference
- [FastAPI Metadata Tutorial](https://fastapi.tiangolo.com/tutorial/metadata/) - FastAPI OpenAPI customization
- [FastAPI OpenAPI Techniques](https://blog.greeden.me/en/2026/02/17/fastapi-openapi-power-techniques/) - Advanced patterns
- [CodingEasyPeasy Flask OpenAPI Guide](https://www.codingeasypeasy.com/blog/documenting-flask-apis-a-comprehensive-guide-with-openapi-swagger-and-more) - Flask documentation approaches
- [jentic-openapi-parser PyPI](https://pypi.org/project/jentic-openapi-parser/) - Advanced OpenAPI parsing