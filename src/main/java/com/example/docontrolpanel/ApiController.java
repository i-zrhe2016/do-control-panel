package com.example.docontrolpanel;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class ApiController {

  private final DigitalOceanService service;

  public ApiController(DigitalOceanService service) {
    this.service = service;
  }

  @GetMapping("/health")
  public Map<String, Object> health() {
    requireConfigured();

    Map<String, Object> body = new LinkedHashMap<>();
    body.put("ok", true);
    return body;
  }

  @GetMapping("/droplets")
  public Map<String, Object> droplets() {
    requireConfigured();

    Map<String, Object> body = new LinkedHashMap<>();
    body.put("droplets", service.listDroplets());
    return body;
  }

  @GetMapping("/credits")
  public Map<String, Object> credits() {
    requireConfigured();

    Map<String, Object> body = new LinkedHashMap<>();
    body.put("credits", service.getAvailableCredits());
    return body;
  }

  @GetMapping("/balance")
  public ResponseEntity<Map<String, Object>> balance() {
    requireConfigured();

    Map<String, Object> body = new LinkedHashMap<>();
    body.put("error", "Deprecated endpoint. Use /api/credits.");
    return ResponseEntity.status(HttpStatus.GONE).body(body);
  }

  @PostMapping("/droplets")
  public ResponseEntity<Map<String, Object>> createDroplet(@RequestBody(required = false) Map<String, Object> body) {
    requireConfigured();
    return ResponseEntity.status(HttpStatus.CREATED).body(service.createDroplet(body));
  }

  @PatchMapping("/droplets/{id}/rename")
  public ResponseEntity<Map<String, Object>> renameDroplet(
      @PathVariable("id") long id,
      @RequestBody(required = false) Map<String, Object> body
  ) {
    requireConfigured();
    return ResponseEntity.status(HttpStatus.ACCEPTED).body(service.renameDroplet(id, body));
  }

  @PatchMapping("/droplets/{id}/tags")
  public Map<String, Object> updateDropletTags(
      @PathVariable("id") long id,
      @RequestBody(required = false) Map<String, Object> body
  ) {
    requireConfigured();
    return service.updateDropletTags(id, body);
  }

  @PostMapping("/droplets/{id}/rebuild")
  public ResponseEntity<Map<String, Object>> rebuildDroplet(
      @PathVariable("id") long id,
      @RequestBody(required = false) Map<String, Object> ignored
  ) {
    requireConfigured();
    return ResponseEntity.status(HttpStatus.ACCEPTED).body(service.rebuildDroplet(id));
  }

  @DeleteMapping("/droplets/{id}")
  public Map<String, Object> deleteDroplet(@PathVariable("id") long id) {
    requireConfigured();
    return service.deleteDroplet(id);
  }

  @DeleteMapping("/droplets/by-tag/{tagName}")
  public Map<String, Object> deleteDropletsByTag(@PathVariable("tagName") String tagName) {
    requireConfigured();

    String normalizedTag = tagName == null ? "" : tagName.trim();
    if (normalizedTag.isEmpty()) {
      throw new ApiException(400, "Tag is required", null);
    }

    return service.deleteDropletsByTag(normalizedTag);
  }

  @RequestMapping(value = "/**", method = {
      RequestMethod.GET,
      RequestMethod.POST,
      RequestMethod.PATCH,
      RequestMethod.PUT,
      RequestMethod.DELETE,
      RequestMethod.OPTIONS,
      RequestMethod.HEAD
  })
  public ResponseEntity<Map<String, Object>> notFound() {
    requireConfigured();

    Map<String, Object> body = new LinkedHashMap<>();
    body.put("error", "Not found");
    return ResponseEntity.status(HttpStatus.NOT_FOUND).body(body);
  }

  private void requireConfigured() {
    service.ensureConfigured();
  }
}
