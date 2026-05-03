---
title: "Angular AppModule has empty outgoing relationships -- imports/providers/decorators not tracked"
labels: [triage, low]
---

## Steps to reproduce

1. Index `sample-angular`
2. Call `context` on `AppModule`:
   ```
   context(name="AppModule", repo="sample-angular", include_content=true)
   ```

## Actual behavior

`AppModule` context shows:
```json
{
  "incoming": {},
  "outgoing": {}
}
```

Despite the source code clearly declaring:
```typescript
@NgModule({
  imports: [HttpClientModule],
  providers: [UserService, OrderService, AuthService],
})
export class AppModule {}
```

## Expected behavior

`AppModule` should have outgoing relationships reflecting:
- `imports`: `HttpClientModule`
- `providers`: `UserService`, `OrderService`, `AuthService`

At minimum, the IMPORTS relationship should track the `@NgModule` decorator's `imports` array, and the `providers` should be tracked as dependency relationships.

## User impact

**LOW** -- Angular module structure is invisible in the knowledge graph. Users cannot trace which modules import which, or which services are provided by which module. However, some of this information can be recovered through file-level IMPORTS edges (e.g., the app.module.ts file imports UserService).