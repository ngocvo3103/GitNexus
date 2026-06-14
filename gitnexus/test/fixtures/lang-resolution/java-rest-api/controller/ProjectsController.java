package org.example.web;

import jakarta.validation.Valid;
import org.example.domain.Project;
import org.example.repo.ProjectRepository;
import org.example.repo.ProjectSpecifications;
import org.example.repo.DocumentRepository;
import org.example.web.dto.ProjectCreateRequest;
import org.example.web.dto.ProjectDetailResponse;
import org.example.web.dto.DocumentSummary;
import org.example.service.ProjectService;
import org.example.service.mapper.ProjectMapper;
import org.example.common.Constants;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;
import common.Constants;

@RestController
@RequestMapping(Constants.PROJECTS_PATH)
@Tag(name = "Projects", description = "Project management operations - create, read, update, delete projects")
@SecurityRequirement(name = "bearer-jwt")
public class ProjectsController {
    private final ProjectRepository projectRepository;
    private final DocumentRepository documentRepository;
    private final ProjectService projectService;
    private final ProjectMapper projectMapper;

    public ProjectsController(ProjectRepository projectRepository,
                             DocumentRepository documentRepository,
                             ProjectService projectService,
                             ProjectMapper projectMapper) {
        this.projectRepository = projectRepository;
        this.documentRepository = documentRepository;
        this.projectService = projectService;
        this.projectMapper = projectMapper;
    }

    @GetMapping
    @Operation(
        summary = "List all projects with filters",
        description = "Retrieve paginated list of projects with optional filters for code, status, dates, departments, and staff"
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Successfully retrieved project list"),
        @ApiResponse(responseCode = "400", description = "Invalid filter parameters", content = @Content),
        @ApiResponse(responseCode = "401", description = "Unauthorized - JWT token required", content = @Content)
    })
    public Page<Project> list(
        @Parameter(description = "Page number (0-indexed)") @RequestParam(defaultValue = "0") int page,
        @Parameter(description = "Page size") @RequestParam(defaultValue = "10") int size,
        @Parameter(description = "Sort field and direction (e.g., 'name,asc' or 'startDate,desc')") @RequestParam(required = false) String sort,
        @Parameter(description = "Filter by project code (exact match)") @RequestParam(required = false, name = "project_code") String projectCode,
        @Parameter(description = "Filter by status (comma-separated for multiple)") @RequestParam(required = false, name = "status") String statusCsv,
        @Parameter(description = "Filter by start date from (YYYY-MM-DD)") @RequestParam(required = false, name = "start_date_from") String startFrom,
        @Parameter(description = "Filter by start date to (YYYY-MM-DD)") @RequestParam(required = false, name = "start_date_to") String startTo,
        @Parameter(description = "Filter by end date from (YYYY-MM-DD)") @RequestParam(required = false, name = "end_date_from") String endFrom,
        @Parameter(description = "Filter by end date to (YYYY-MM-DD)") @RequestParam(required = false, name = "end_date_to") String endTo,
        @Parameter(description = "Filter by lead department") @RequestParam(required = false, name = "lead_department") String leadDepartment,
        @Parameter(description = "Filter by lead staff") @RequestParam(required = false, name = "lead_staff") String leadStaff,
        @Parameter(description = "Filter by project manager") @RequestParam(required = false, name = "project_manager") String projectManager,
        @Parameter(description = "Filter by requirement (contains search)") @RequestParam(required = false, name = "requirement") String requirementContains
    ) {
        Sort sortObj = Sort.unsorted();
        if (sort != null && !sort.isBlank()) {
            String[] parts = sort.split(",");
            String prop = parts[0];
            Sort.Direction dir = (parts.length > 1 && parts[1].equalsIgnoreCase("desc")) ? Sort.Direction.DESC : Sort.Direction.ASC;
            sortObj = Sort.by(dir, prop);
        }
        Pageable pageable = PageRequest.of(page, size, sortObj);
        List<String> statuses = new ArrayList<>();
        if (statusCsv != null && !statusCsv.isBlank()) {
            statuses = Arrays.stream(statusCsv.split(","))
                    .map(String::trim)
                    .filter(s -> !s.isBlank())
                    .toList();
        }
        LocalDate sdFrom = startFrom != null && !startFrom.isBlank() ? LocalDate.parse(startFrom) : null;
        LocalDate sdTo = startTo != null && !startTo.isBlank() ? LocalDate.parse(startTo) : null;
        LocalDate edFrom = endFrom != null && !endFrom.isBlank() ? LocalDate.parse(endFrom) : null;
        LocalDate edTo = endTo != null && !endTo.isBlank() ? LocalDate.parse(endTo) : null;

        Specification<Project> spec = ProjectSpecifications.filter(
                projectCode, statuses, sdFrom, sdTo, edFrom, edTo, leadDepartment, leadStaff, projectManager, requirementContains
        );
        return projectRepository.findAll(spec, pageable);
    }

    @GetMapping("/{id}")
    @Operation(
        summary = "Get project details by ID",
        description = "Retrieve detailed information about a specific project including associated documents"
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Project found", content = @Content(schema = @Schema(implementation = ProjectDetailResponse.class))),
        @ApiResponse(responseCode = "404", description = "Project not found", content = @Content),
        @ApiResponse(responseCode = "401", description = "Unauthorized", content = @Content)
    })
    public ResponseEntity<ProjectDetailResponse> get(
        @Parameter(description = "Project UUID", required = true) @PathVariable UUID id
    ) {
        return projectRepository.findById(id)
                .filter(p -> p.getDeleted() == null || !p.getDeleted())
                .map(project -> {
                    // Fetch documents
                    var docs = documentRepository.findByProjectIdAndDeletedFalse(project.getId());
                    List<DocumentSummary> documentSummaries = docs == null ? List.of() : docs.stream()
                            .map(d -> new DocumentSummary(d.getId(), d.getName(), d.getPath(), d.getSize()))
                            .collect(Collectors.toList());

                    // Use mapper to convert
                    ProjectDetailResponse response = projectMapper.toDetailResponse(project, documentSummaries);
                    return ResponseEntity.ok(response);
                })
                .orElse(ResponseEntity.status(HttpStatus.NOT_FOUND).<ProjectDetailResponse>build());
    }

    @PostMapping
    @PreAuthorize("hasRole('Admin')")
    @Operation(
        summary = "Create a new project",
        description = "Create a new project with auto-generated code (DA-{year}-{seq}). Requires Admin role."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "201", description = "Project created successfully", content = @Content(schema = @Schema(implementation = Project.class))),
        @ApiResponse(responseCode = "400", description = "Invalid request - validation errors", content = @Content),
        @ApiResponse(responseCode = "401", description = "Unauthorized", content = @Content),
        @ApiResponse(responseCode = "403", description = "Forbidden - Admin role required", content = @Content)
    })
    public ResponseEntity<Project> create(
        @Parameter(description = "Project creation request", required = true) @Valid @RequestBody ProjectCreateRequest req
    ) {
        // Validate date logic
        if (req.getStartDate() == null || req.getEndDate() == null) {
            return ResponseEntity.badRequest().<Project>build();
        }
        if (req.getEndDate().isBefore(req.getStartDate())) {
            return ResponseEntity.badRequest().<Project>build();
        }

        // Use mapper to convert DTO to Entity
        Project project = projectMapper.toEntity(req);

        // Delegate save to service (service will set code and deleted)
        Project saved = projectService.create(project);
        return ResponseEntity.status(HttpStatus.CREATED).body(saved);
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasRole('Admin')")
    @Operation(
        summary = "Update an existing project",
        description = "Update project fields. Only non-null fields are updated. ID and code cannot be changed. Requires Admin role."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "200", description = "Project updated successfully", content = @Content(schema = @Schema(implementation = Project.class))),
        @ApiResponse(responseCode = "400", description = "Invalid request - validation errors", content = @Content),
        @ApiResponse(responseCode = "404", description = "Project not found", content = @Content),
        @ApiResponse(responseCode = "401", description = "Unauthorized", content = @Content),
        @ApiResponse(responseCode = "403", description = "Forbidden - Admin role required", content = @Content)
    })
    public ResponseEntity<Project> update(
        @Parameter(description = "Project UUID", required = true) @PathVariable UUID id,
        @Parameter(description = "Project update data", required = true) @RequestBody Project updates
    ) {
        return projectRepository.findById(id)
                .map(existing -> {
                    // Use mapper to update entity
                    projectMapper.updateEntity(existing, updates);

                    // Validate date logic if both dates are present
                    if (existing.getStartDate() != null && existing.getEndDate() != null
                        && existing.getEndDate().isBefore(existing.getStartDate())) {
                        return ResponseEntity.badRequest().<Project>build();
                    }

                    Project updated = projectService.update(existing);
                    return ResponseEntity.ok(updated);
                })
                .orElse(ResponseEntity.status(HttpStatus.NOT_FOUND).<Project>build());
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('Admin')")
    @Operation(
        summary = "Soft delete a project",
        description = "Soft delete a project and cascade to all related entities (packages, contracts, documents). Requires Admin role."
    )
    @ApiResponses({
        @ApiResponse(responseCode = "204", description = "Project deleted successfully"),
        @ApiResponse(responseCode = "404", description = "Project not found", content = @Content),
        @ApiResponse(responseCode = "401", description = "Unauthorized", content = @Content),
        @ApiResponse(responseCode = "403", description = "Forbidden - Admin role required", content = @Content)
    })
    public ResponseEntity<Void> delete(
        @Parameter(description = "Project UUID", required = true) @PathVariable UUID id
    ) {
        return projectRepository.findById(id)
                .map(p -> {
                    projectService.softDelete(p);
                    return ResponseEntity.noContent().<Void>build();
                })
                .orElse(ResponseEntity.status(HttpStatus.NOT_FOUND).<Void>build());
    }
}
