| n.id | n.name | n.filePath | n.httpMethod | n.handler | n.controller | n.framework | n.prefix | n.lineNumber | n.responseKeys | n.errorKeys | n.middleware |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Route:GET:/{id} | /{id} | src/main/java/org/example/web/ProjectsController.java | GET | get | ProjectsController | spring |  | 110 | [] | [] | [] |
| Route:PUT:/{id} | /{id} | src/main/java/org/example/web/ProjectsController.java | PUT | update | ProjectsController | spring |  | 170 | [] | [] | [] |
| Route:DELETE:/{id} | /{id} | src/main/java/org/example/web/ProjectsController.java | DELETE | delete | ProjectsController | spring |  | 204 | [] | [] | [] |
| Route:GET:/api/projects/{projectId}/packages | /api/projects/{projectId}/packages | src/main/java/org/example/web/PackagesController.java | GET | list | PackagesController | spring |  | 27 | [] | [] | [] |
| Route:POST:/api/projects/{projectId}/packages | /api/projects/{projectId}/packages | src/main/java/org/example/web/PackagesController.java | POST | create | PackagesController | spring |  | 33 | [] | [] | [] |
| Route:GET:/api/packages/{id} | /api/packages/{id} | src/main/java/org/example/web/PackagesController.java | GET | get | PackagesController | spring |  | 41 | [] | [] | [] |
| Route:PUT:/api/packages/{id} | /api/packages/{id} | src/main/java/org/example/web/PackagesController.java | PUT | update | PackagesController | spring |  | 46 | [] | [] | [] |
| Route:GET:/api/packages/{id}/contract | /api/packages/{id}/contract | src/main/java/org/example/web/PackagesController.java | GET | getContract | PackagesController | spring |  | 55 | [] | [] | [] |
| Route:POST:/api/packages/{id}/contract | /api/packages/{id}/contract | src/main/java/org/example/web/PackagesController.java | POST | saveContract | PackagesController | spring |  | 62 | [] | [] | [] |
| Route:POST:/api/documents/upload | /api/documents/upload | src/main/java/org/example/web/DocumentsController.java | POST | upload | DocumentsController | spring |  | 31 | [] | [] | [] |
| Route:POST:/api/documents/download | /api/documents/download | src/main/java/org/example/web/DocumentsController.java | POST | downloadZip | DocumentsController | spring |  | 40 | [] | [] | [] |
| Route:GET:/api/documents | /api/documents | src/main/java/org/example/web/DocumentsController.java | GET | search | DocumentsController | spring |  | 50 | [] | [] | [] |
| Route:GET:/api/projects/{projectId}/documents | /api/projects/{projectId}/documents | src/main/java/org/example/web/DocumentsController.java | GET | listByProject | DocumentsController | spring |  | 59 | [] | [] | [] |
| Route:POST:/api/documents/{id}/link | /api/documents/{id}/link | src/main/java/org/example/web/DocumentsController.java | POST | linkDocument | DocumentsController | spring |  | 65 | [] | [] | [] |
| Route:POST:/api/documents/{id}/unlink | /api/documents/{id}/unlink | src/main/java/org/example/web/DocumentsController.java | POST | unlinkDocument | DocumentsController | spring |  | 77 | [] | [] | [] |
| Route:POST:/auth/login | /auth/login | src/main/java/org/example/web/AuthController.java | POST | login | AuthController | spring |  | 26 | [] | [] | [] |
| Route:POST:/auth/refresh | /auth/refresh | src/main/java/org/example/web/AuthController.java | POST | refresh | AuthController | spring |  | 33 | [] | [] | [] |
| Route:GET:/auth/users/me | /auth/users/me | src/main/java/org/example/web/AuthController.java | GET | me | AuthController | spring |  | 40 | [] | [] | [] |"