package com.example.docontrolpanel;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class DigitalOceanService {

  private static final String DO_API_BASE = "https://api.digitalocean.com/v2";
  private static final String DEFAULT_REGION = "sgp1";
  private static final Map<String, String> ALLOWED_REGIONS = Map.of(
      "sfo3", "San Francisco",
      "sgp1", "Singapore",
      "blr1", "Bangalore"
  );
  private static final String DEFAULT_SIZE = "s-1vcpu-1gb";
  private static final String FIXED_IMAGE = "ubuntu-22-04-x64";
  private static final long SIZE_CACHE_TTL_MS = 30_000;
  private static final int SIZE_PAGE_SIZE = 200;
  private static final int SIZE_MAX_PAGES = 20;
  private static final long CREDITS_CACHE_TTL_MS = 15_000;
  private static final int INVOICE_PAGE_SIZE = 100;
  private static final int INVOICE_MAX_PAGES = 100;
  private static final Comparator<SizeOption> SIZE_SORT_COMPARATOR = Comparator
      .comparingInt((SizeOption size) -> DEFAULT_SIZE.equals(size.slug()) ? 0 : 1)
      .thenComparingDouble(SizeOption::monthlyUsd)
      .thenComparingInt(SizeOption::vcpus)
      .thenComparingInt(SizeOption::memoryMb)
      .thenComparing(SizeOption::slug);

  private static final List<String> DIRECT_CREDITS_KEYS = List.of(
      "available_credits",
      "availableCredits",
      "credits_balance",
      "creditsBalance",
      "credit_balance",
      "creditBalance",
      "remaining_credits",
      "remainingCredits",
      "promo_credit_remaining",
      "promoCreditRemaining"
  );

  private final ObjectMapper objectMapper;
  private final HttpClient httpClient;
  private final String apiToken;
  private final String defaultSshPublicKey;
  private final double studentPackInitialCredits;

  private volatile CreditsCache creditsCache = new CreditsCache(null, 0);
  private volatile SizeCache sizeCache = new SizeCache(List.of(), 0);

  public DigitalOceanService(
      ObjectMapper objectMapper,
      @Value("${DO_API_TOKEN:}") String apiToken,
      @Value("${DO_DEFAULT_SSH_PUBLIC_KEY:}") String defaultSshPublicKey,
      @Value("${DO_STUDENT_PACK_INITIAL_CREDITS:200}") String initialCredits
  ) {
    this.objectMapper = objectMapper;
    this.httpClient = HttpClient.newBuilder().build();
    this.apiToken = trimToEmpty(apiToken);
    this.defaultSshPublicKey = trimToEmpty(defaultSshPublicKey);
    this.studentPackInitialCredits = numberOrDefault(initialCredits, 200);
  }

  public void ensureConfigured() {
    if (apiToken.isEmpty()) {
      throw new ApiException(500, "Missing DO_API_TOKEN environment variable", null);
    }
  }

  public List<Map<String, Object>> listDroplets() {
    List<Map<String, Object>> all = new ArrayList<>();
    int page = 1;

    while (true) {
      JsonNode data = doApi("/droplets?page=" + page + "&per_page=100", "GET", null);
      JsonNode droplets = data.path("droplets");
      int currentCount = 0;

      if (droplets.isArray()) {
        for (JsonNode droplet : droplets) {
          all.add(dropletToView(droplet));
          currentCount += 1;
        }
      }

      if (currentCount < 100) {
        break;
      }

      page += 1;
    }

    return all;
  }

  public synchronized Map<String, Object> getAvailableCredits() {
    CreditsCache currentCache = creditsCache;
    if (currentCache.value() != null && currentCache.expiresAt() > System.currentTimeMillis()) {
      return currentCache.value();
    }

    JsonNode balanceData;
    try {
      balanceData = doApi("/customers/my/balance", "GET", null);
    } catch (Exception ignored) {
      balanceData = objectMapper.createObjectNode();
    }

    DirectCredits directCredits = pickDirectCreditsValue(balanceData);
    Map<String, Object> credits;

    if (directCredits != null) {
      credits = new LinkedHashMap<>();
      credits.put("availableCredits", roundUsd(directCredits.value()));
      credits.put("generatedAt", textOrNull(balanceData.get("generated_at")));
      credits.put("source", "balance_field");
      credits.put("exact", true);
      credits.put("note", "DigitalOcean balance response field: " + directCredits.key());
    } else {
      InvoiceData invoiceData = listInvoices();
      List<JsonNode> summaries = new ArrayList<>();

      for (JsonNode invoice : invoiceData.invoices()) {
        String invoiceUuid = trimToEmpty(textOrNull(invoice.get("invoice_uuid")));
        if (!invoiceUuid.isEmpty()) {
          summaries.add(getInvoiceSummary(invoiceUuid));
        }
      }

      JsonNode previewSummary;
      try {
        previewSummary = getInvoicePreviewSummary();
      } catch (Exception ignored) {
        previewSummary = null;
      }

      List<JsonNode> allSummaries = new ArrayList<>(summaries);
      if (previewSummary != null && !previewSummary.isMissingNode() && !previewSummary.isNull()) {
        allSummaries.add(previewSummary);
      }

      Map<String, Object> summary = summarizeCreditsFromInvoices(allSummaries, studentPackInitialCredits);
      credits = new LinkedHashMap<>(summary);
      Object generatedAt = summary.get("generatedAt");
      credits.put("generatedAt", generatedAt != null ? generatedAt : textOrNull(balanceData.get("generated_at")));
      credits.put("source", "invoice_summaries");
      credits.put("exact", false);
      credits.put(
          "note",
          "Estimated from a $" + roundUsd(studentPackInitialCredits)
              + " GitHub Student Pack using invoice summaries and the current invoice preview."
      );
    }

    creditsCache = new CreditsCache(Collections.unmodifiableMap(new LinkedHashMap<>(credits)),
        System.currentTimeMillis() + CREDITS_CACHE_TTL_MS);

    return credits;
  }

  public List<Map<String, Object>> listPopularSizes(String query, String regionValue) {
    String keyword = trimToEmpty(query).toLowerCase(Locale.ROOT);
    String region = normalizeRegionOrDefault(regionValue);
    List<Map<String, Object>> result = new ArrayList<>();

    for (SizeOption size : listStudentPackageSizes()) {
      if ((keyword.isEmpty() || size.matches(keyword)) && size.regions().contains(region)) {
        result.add(size.toView(DEFAULT_SIZE.equals(size.slug())));
      }
    }

    return result;
  }

  public Map<String, Object> createDroplet(Map<String, Object> body) {
    Map<String, Object> requestBody = body == null ? Map.of() : body;

    String requestedName = trimToEmpty(asString(requestBody.get("name")));
    String nameInput = requestedName.isEmpty() ? "do-" + System.currentTimeMillis() : requestedName;

    String name = sanitizeName(nameInput);
    List<String> tags = normalizeTags(requestBody.get("tags"));
    String region = normalizeRegion(requestBody.get("region"));
    String size = normalizeSize(requestBody.get("size"), region);
    String requestedFingerprint = trimToEmpty(asString(requestBody.get("sshKeyFingerprint")));
    String defaultFingerprint = requestedFingerprint.isEmpty() ? ensureDefaultSshKeyFingerprint() : null;

    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("name", name);
    payload.put("region", region);
    payload.put("size", size);
    payload.put("image", FIXED_IMAGE);

    if (!tags.isEmpty()) {
      payload.put("tags", tags);
    }

    if (!requestedFingerprint.isEmpty() || trimToEmpty(defaultFingerprint).length() > 0) {
      payload.put("ssh_keys", List.of(!requestedFingerprint.isEmpty() ? requestedFingerprint : defaultFingerprint));
    }

    JsonNode data = doApi("/droplets", "POST", payload);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("droplet", dropletToView(data.path("droplet")));

    Map<String, Object> profile = new LinkedHashMap<>();
    profile.put("region", region);
    profile.put("size", size);
    profile.put("image", FIXED_IMAGE);

    result.put("profile", profile);
    return result;
  }

  public Map<String, Object> renameDroplet(long dropletId, Map<String, Object> body) {
    Map<String, Object> requestBody = body == null ? Map.of() : body;
    String name = sanitizeName(requestBody.get("name"));

    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("type", "rename");
    payload.put("name", name);

    JsonNode action = doApi("/droplets/" + dropletId + "/actions", "POST", payload);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("action", nodeToValueOrNull(action.get("action")));
    result.put("message", "Rename action submitted");
    return result;
  }

  public Map<String, Object> updateDropletTags(long dropletId, Map<String, Object> body) {
    Map<String, Object> requestBody = body == null ? Map.of() : body;
    List<String> targetTags = normalizeTags(requestBody.get("tags"));
    List<String> currentTags = getDropletTags(dropletId);

    List<String> tagsToAdd = new ArrayList<>();
    List<String> tagsToRemove = new ArrayList<>();

    for (String tag : targetTags) {
      if (!currentTags.contains(tag)) {
        tagsToAdd.add(tag);
      }
    }

    for (String tag : currentTags) {
      if (!targetTags.contains(tag)) {
        tagsToRemove.add(tag);
      }
    }

    for (String tag : tagsToAdd) {
      addTagToDroplet(tag, dropletId);
    }

    for (String tag : tagsToRemove) {
      removeTagFromDroplet(tag, dropletId);
    }

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("ok", true);
    result.put("tags", targetTags);
    result.put("added", tagsToAdd);
    result.put("removed", tagsToRemove);
    return result;
  }

  public Map<String, Object> rebuildDroplet(long dropletId) {
    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("type", "rebuild");
    payload.put("image", FIXED_IMAGE);

    JsonNode action = doApi("/droplets/" + dropletId + "/actions", "POST", payload);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("action", nodeToValueOrNull(action.get("action")));
    result.put("message", "Rebuild action submitted");
    result.put("image", FIXED_IMAGE);
    return result;
  }

  public Map<String, Object> deleteDroplet(long dropletId) {
    doApi("/droplets/" + dropletId, "DELETE", null);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("ok", true);
    return result;
  }

  public Map<String, Object> deleteDropletsByTag(String tagName) {
    List<Map<String, Object>> droplets = listDroplets();
    List<Map<String, Object>> targets = new ArrayList<>();

    for (Map<String, Object> droplet : droplets) {
      Object tagsValue = droplet.get("tags");
      if (tagsValue instanceof Collection<?> tags && tags.contains(tagName)) {
        targets.add(droplet);
      }
    }

    List<Long> deletedIds = new ArrayList<>();
    List<Map<String, Object>> failed = new ArrayList<>();

    for (Map<String, Object> droplet : targets) {
      Object idValue = droplet.get("id");
      Long dropletId = toLongOrNull(idValue);
      if (dropletId == null) {
        continue;
      }

      try {
        doApi("/droplets/" + dropletId, "DELETE", null);
        deletedIds.add(dropletId);
      } catch (Exception err) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", dropletId);
        item.put("error", trimToEmpty(err.getMessage()).isEmpty() ? "Delete failed" : err.getMessage());
        failed.add(item);
      }
    }

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("tag", tagName);
    result.put("matched", targets.size());
    result.put("deleted", deletedIds.size());
    result.put("deletedIds", deletedIds);
    result.put("failed", failed);
    return result;
  }

  private JsonNode doApi(String pathname, String method, Object body) {
    if (apiToken.isEmpty()) {
      throw new ApiException(500, "Missing DO_API_TOKEN", null);
    }

    HttpRequest.BodyPublisher publisher = HttpRequest.BodyPublishers.noBody();
    if (body != null) {
      try {
        publisher = HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body));
      } catch (JsonProcessingException e) {
        throw new ApiException(500, "Failed to serialize request payload", null);
      }
    }

    HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create(DO_API_BASE + pathname))
        .method(method, publisher)
        .header("Authorization", "Bearer " + apiToken)
        .header("Content-Type", "application/json")
        .build();

    HttpResponse<String> response;
    try {
      response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
    } catch (IOException | InterruptedException e) {
      if (e instanceof InterruptedException) {
        Thread.currentThread().interrupt();
      }
      throw new ApiException(502, "DigitalOcean API request failed", null);
    }

    JsonNode json;
    String text = response.body();

    try {
      json = trimToEmpty(text).isEmpty() ? objectMapper.createObjectNode() : objectMapper.readTree(text);
    } catch (Exception ignored) {
      LinkedHashMap<String, Object> raw = new LinkedHashMap<>();
      raw.put("raw", text);
      json = objectMapper.valueToTree(raw);
    }

    if (response.statusCode() < 200 || response.statusCode() >= 300) {
      String message = textOrNull(json.get("message"));
      if (message == null || message.isEmpty()) {
        message = textOrNull(json.get("id"));
      }
      if (message == null || message.isEmpty()) {
        message = "DigitalOcean API request failed";
      }

      throw new ApiException(response.statusCode(), message, nodeToValueOrNull(json));
    }

    return json;
  }

  private Map<String, Object> dropletToView(JsonNode droplet) {
    JsonNode v4 = droplet.path("networks").path("v4");
    String publicIp = null;

    if (v4.isArray()) {
      for (JsonNode network : v4) {
        if ("public".equals(textOrNull(network.get("type")))) {
          publicIp = textOrNull(network.get("ip_address"));
          break;
        }
      }
    }

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("id", nodeToValueOrNull(droplet.get("id")));
    result.put("name", textOrNull(droplet.get("name")));
    result.put("status", textOrNull(droplet.get("status")));
    result.put("region", textOrNull(droplet.path("region").get("slug")));

    String sizeSlug = textOrNull(droplet.get("size_slug"));
    if (sizeSlug == null) {
      sizeSlug = textOrNull(droplet.path("size").get("slug"));
    }
    result.put("size", sizeSlug);

    String image = textOrNull(droplet.path("image").get("slug"));
    if (image == null) {
      image = textOrNull(droplet.path("image").get("name"));
    }
    result.put("image", image);

    result.put("tags", normalizeTags(droplet.path("tags")));
    result.put("publicIp", publicIp);
    result.put("createdAt", textOrNull(droplet.get("created_at")));

    return result;
  }

  private InvoiceData listInvoices() {
    List<JsonNode> invoices = new ArrayList<>();
    JsonNode invoicePreview = null;
    int page = 1;

    while (page <= INVOICE_MAX_PAGES) {
      JsonNode data = doApi("/customers/my/invoices?page=" + page + "&per_page=" + INVOICE_PAGE_SIZE, "GET", null);
      List<JsonNode> pageInvoices = extractList(data, List.of("invoices"));
      invoices.addAll(pageInvoices);

      if (invoicePreview == null && data.has("invoice_preview")) {
        invoicePreview = data.get("invoice_preview");
      }

      if (pageInvoices.size() < INVOICE_PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    return new InvoiceData(invoices, invoicePreview);
  }

  private JsonNode getInvoiceSummary(String invoiceUuid) {
    return doApi("/customers/my/invoices/" + invoiceUuid + "/summary", "GET", null);
  }

  private JsonNode getInvoicePreviewSummary() {
    return doApi("/customers/my/invoices/preview/summary", "GET", null);
  }

  private double getSummaryCreditsAmount(JsonNode summary) {
    JsonNode lineItems = summary.path("credits").path("items");
    List<Double> lineItemAmounts = new ArrayList<>();

    if (lineItems.isArray()) {
      for (JsonNode item : lineItems) {
        Double amount = numberOrNull(item.get("amount"));
        if (amount != null) {
          lineItemAmounts.add(amount);
        }
      }
    }

    if (!lineItemAmounts.isEmpty()) {
      double total = 0;
      for (Double value : lineItemAmounts) {
        total += Math.abs(value);
      }
      return roundUsd(total);
    }

    Double amount = numberOrNull(summary.path("credits").get("amount"));
    if (amount != null) {
      return roundUsd(Math.abs(amount));
    }

    return 0;
  }

  private Map<String, Object> summarizeCreditsFromInvoices(List<JsonNode> summaries, double initialCredits) {
    double consumedCredits = 0;
    String generatedAt = null;

    for (JsonNode summary : summaries) {
      consumedCredits += getSummaryCreditsAmount(summary);

      String timestamp = firstNonBlank(
          textOrNull(summary.get("invoice_generated_at")),
          textOrNull(summary.get("updated_at")),
          textOrNull(summary.get("issue_date"))
      );

      generatedAt = latestTimestamp(generatedAt, timestamp);
    }

    double roundedConsumed = roundUsd(consumedCredits);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("initialCredits", roundUsd(initialCredits));
    result.put("consumedCredits", roundedConsumed);
    result.put("availableCredits", roundUsd(Math.max(0, initialCredits - roundedConsumed)));
    result.put("invoiceCount", summaries.size());
    result.put("generatedAt", generatedAt);
    return result;
  }

  private DirectCredits pickDirectCreditsValue(JsonNode data) {
    for (String key : DIRECT_CREDITS_KEYS) {
      Double value = numberOrNull(data.get(key));
      if (value != null) {
        return new DirectCredits(key, value);
      }
    }

    return null;
  }

  private List<Map<String, Object>> listSshKeys() {
    List<Map<String, Object>> all = new ArrayList<>();
    int page = 1;

    while (true) {
      JsonNode data = doApi("/account/keys?page=" + page + "&per_page=200", "GET", null);
      JsonNode keys = data.path("ssh_keys");
      int count = 0;

      if (keys.isArray()) {
        for (JsonNode key : keys) {
          all.add(objectMapper.convertValue(key, objectMapper.getTypeFactory().constructMapType(Map.class, String.class, Object.class)));
          count += 1;
        }
      }

      if (count < 200) {
        break;
      }

      page += 1;
    }

    return all;
  }

  private String ensureDefaultSshKeyFingerprint() {
    if (defaultSshPublicKey.isEmpty()) {
      return null;
    }

    String normalized = normalizePubKey(defaultSshPublicKey);

    for (Map<String, Object> key : listSshKeys()) {
      String publicKey = normalizePubKey(key.get("public_key"));
      if (publicKey.equals(normalized)) {
        String fingerprint = trimToEmpty(asString(key.get("fingerprint")));
        if (!fingerprint.isEmpty()) {
          return fingerprint;
        }
      }
    }

    try {
      Map<String, Object> createBody = new LinkedHashMap<>();
      createBody.put("name", "do-panel-key-" + System.currentTimeMillis());
      createBody.put("public_key", defaultSshPublicKey);

      JsonNode created = doApi("/account/keys", "POST", createBody);
      return textOrNull(created.path("ssh_key").get("fingerprint"));
    } catch (Exception err) {
      for (Map<String, Object> key : listSshKeys()) {
        String publicKey = normalizePubKey(key.get("public_key"));
        if (publicKey.equals(normalized)) {
          String fingerprint = trimToEmpty(asString(key.get("fingerprint")));
          if (!fingerprint.isEmpty()) {
            return fingerprint;
          }
        }
      }

      if (err instanceof ApiException apiException) {
        throw apiException;
      }

      throw new ApiException(500, trimToEmpty(err.getMessage()).isEmpty() ? "Failed to ensure SSH key" : err.getMessage(), null);
    }
  }

  private List<String> getDropletTags(long dropletId) {
    JsonNode data = doApi("/droplets/" + dropletId, "GET", null);
    return normalizeTags(data.path("droplet").path("tags"));
  }

  private void addTagToDroplet(String tagName, long dropletId) {
    try {
      doApi("/tags/" + encodePathSegment(tagName) + "/resources", "POST", tagResourcePayload(dropletId));
    } catch (ApiException err) {
      if (err.getStatus() != 404) {
        throw err;
      }

      Map<String, Object> payload = new LinkedHashMap<>();
      payload.put("name", tagName);

      try {
        doApi("/tags", "POST", payload);
      } catch (ApiException createErr) {
        if (createErr.getStatus() != 422) {
          throw createErr;
        }
      }

      doApi("/tags/" + encodePathSegment(tagName) + "/resources", "POST", tagResourcePayload(dropletId));
    }
  }

  private void removeTagFromDroplet(String tagName, long dropletId) {
    doApi("/tags/" + encodePathSegment(tagName) + "/resources", "DELETE", tagResourcePayload(dropletId));
  }

  private Map<String, Object> tagResourcePayload(long dropletId) {
    Map<String, Object> resource = new LinkedHashMap<>();
    resource.put("resource_id", String.valueOf(dropletId));
    resource.put("resource_type", "droplet");

    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("resources", List.of(resource));

    return payload;
  }

  private List<JsonNode> extractList(JsonNode data, List<String> preferredKeys) {
    if (data == null || data.isNull() || data.isMissingNode()) {
      return List.of();
    }

    if (data.isArray()) {
      List<JsonNode> list = new ArrayList<>();
      data.forEach(list::add);
      return list;
    }

    for (String key : preferredKeys) {
      JsonNode candidate = data.get(key);
      if (candidate != null && candidate.isArray()) {
        List<JsonNode> list = new ArrayList<>();
        candidate.forEach(list::add);
        return list;
      }
    }

    var fields = data.fields();
    while (fields.hasNext()) {
      JsonNode value = fields.next().getValue();
      if (value.isArray()) {
        List<JsonNode> list = new ArrayList<>();
        value.forEach(list::add);
        return list;
      }
    }

    return List.of();
  }

  private String sanitizeName(Object name) {
    String raw = trimToEmpty(asString(name)).toLowerCase(Locale.ROOT);
    String safe = raw
        .replaceAll("[^a-z0-9.-]", "-")
        .replaceAll("^-+", "")
        .replaceAll("-+$", "");

    if (safe.length() > 63) {
      safe = safe.substring(0, 63);
    }

    if (safe.isEmpty()) {
      return "do-" + System.currentTimeMillis();
    }

    return safe;
  }

  private List<String> normalizeTags(Object tagsValue) {
    List<String> source = new ArrayList<>();

    if (tagsValue instanceof JsonNode nodeValue) {
      if (nodeValue.isArray()) {
        nodeValue.forEach(item -> source.add(asString(item)));
      } else {
        String text = textOrNull(nodeValue);
        if (text != null) {
          source.addAll(List.of(text.split("[,\\n，]")));
        }
      }
    } else if (tagsValue instanceof Collection<?> collection) {
      for (Object value : collection) {
        source.add(asString(value));
      }
    } else {
      String text = trimToEmpty(asString(tagsValue));
      if (!text.isEmpty()) {
        source.addAll(List.of(text.split("[,\\n，]")));
      }
    }

    LinkedHashSet<String> normalized = new LinkedHashSet<>();
    for (String tag : source) {
      String value = trimToEmpty(tag);
      if (!value.isEmpty()) {
        normalized.add(value);
      }
    }

    return new ArrayList<>(normalized);
  }

  private String normalizeRegion(Object regionValue) {
    return normalizeRegionOrDefault(asString(regionValue));
  }

  private String normalizeRegionOrDefault(String regionValue) {
    String region = trimToEmpty(regionValue);
    if (region.isEmpty()) {
      region = DEFAULT_REGION;
    }

    region = region.toLowerCase(Locale.ROOT);

    if (!ALLOWED_REGIONS.containsKey(region)) {
      throw new ApiException(
          400,
          "Unsupported region. Allowed regions: " + String.join(", ", ALLOWED_REGIONS.keySet()),
          null
      );
    }

    return region;
  }

  private synchronized List<SizeOption> listStudentPackageSizes() {
    SizeCache currentCache = sizeCache;
    long now = System.currentTimeMillis();

    if (currentCache.value() != null && currentCache.expiresAt() > now) {
      return currentCache.value();
    }

    try {
      List<SizeOption> refreshed = fetchStudentPackageSizes();
      List<SizeOption> immutable = List.copyOf(refreshed);
      sizeCache = new SizeCache(immutable, now + SIZE_CACHE_TTL_MS);
      return immutable;
    } catch (Exception err) {
      if (currentCache.value() != null && !currentCache.value().isEmpty()) {
        return currentCache.value();
      }
      throw err;
    }
  }

  private List<SizeOption> fetchStudentPackageSizes() {
    List<SizeOption> all = fetchDoSizes();
    List<SizeOption> filtered = new ArrayList<>();

    for (SizeOption size : all) {
      if (isStudentPackageSupported(size)) {
        filtered.add(size);
      }
    }

    filtered.sort(SIZE_SORT_COMPARATOR);
    return filtered;
  }

  private List<SizeOption> fetchDoSizes() {
    List<SizeOption> all = new ArrayList<>();
    int page = 1;

    while (page <= SIZE_MAX_PAGES) {
      JsonNode data = doApi("/sizes?page=" + page + "&per_page=" + SIZE_PAGE_SIZE, "GET", null);
      JsonNode sizes = data.path("sizes");
      int count = 0;

      if (sizes.isArray()) {
        for (JsonNode sizeNode : sizes) {
          SizeOption parsed = parseSizeOption(sizeNode);
          if (parsed != null) {
            all.add(parsed);
          }
          count += 1;
        }
      }

      if (count < SIZE_PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    return all;
  }

  private SizeOption parseSizeOption(JsonNode sizeNode) {
    String slug = trimToEmpty(textOrNull(sizeNode.get("slug"))).toLowerCase(Locale.ROOT);
    if (slug.isEmpty()) {
      return null;
    }

    String category = firstNonBlank(
        textOrNull(sizeNode.get("description")),
        inferCategoryFromSlug(slug),
        "Unknown"
    );

    int memoryMb = numberToInt(sizeNode.get("memory"), 0);
    int vcpus = numberToInt(sizeNode.get("vcpus"), 0);
    int diskGb = numberToInt(sizeNode.get("disk"), 0);
    Double transferRaw = numberOrNull(sizeNode.get("transfer"));
    Double monthlyRaw = numberOrNull(sizeNode.get("price_monthly"));
    Double hourlyRaw = numberOrNull(sizeNode.get("price_hourly"));
    double transferTb = transferRaw == null ? 0 : round2(transferRaw);
    double monthlyUsd = monthlyRaw == null ? 0 : round2(monthlyRaw);
    double hourlyUsd = hourlyRaw == null ? 0 : round4(hourlyRaw);
    boolean available = boolOrDefault(sizeNode.get("available"), false);
    List<String> regions = normalizeTags(sizeNode.get("regions"));

    return new SizeOption(
        slug,
        category,
        memoryMb,
        vcpus,
        diskGb,
        transferTb,
        monthlyUsd,
        hourlyUsd,
        available,
        regions
    );
  }

  private boolean isStudentPackageSupported(SizeOption size) {
    if (!size.available()) {
      return false;
    }

    if (!size.slug().startsWith("s-")) {
      return false;
    }

    if (size.slug().contains("-amd") || size.slug().contains("-intel")) {
      return false;
    }

    if (size.monthlyUsd() <= 0) {
      return false;
    }

    if (size.regions() == null || size.regions().isEmpty()) {
      return false;
    }

    for (String allowedRegion : ALLOWED_REGIONS.keySet()) {
      if (size.regions().contains(allowedRegion)) {
        return true;
      }
    }

    return false;
  }

  private String inferCategoryFromSlug(String slug) {
    if (slug.startsWith("s-")) {
      return "Basic";
    }
    if (slug.startsWith("c-")) {
      return "CPU-Optimized";
    }
    if (slug.startsWith("g-")) {
      return "General Purpose";
    }
    if (slug.startsWith("m-")) {
      return "Memory-Optimized";
    }
    return "Other";
  }

  private String normalizeSize(Object sizeValue, String region) {
    String size = trimToEmpty(asString(sizeValue)).toLowerCase(Locale.ROOT);
    if (size.isEmpty()) {
      size = DEFAULT_SIZE;
    }

    boolean foundSlug = false;
    List<SizeOption> allowedSizes = listStudentPackageSizes();
    for (SizeOption option : allowedSizes) {
      if (option.slug().equals(size)) {
        foundSlug = true;
      }

      if (option.slug().equals(size) && option.regions().contains(region)) {
        return size;
      }
    }

    if (foundSlug) {
      throw new ApiException(
          400,
          "Size " + size + " is not available in region " + region + ". Use /api/sizes/popular?region=" + region + ".",
          null
      );
    }

    throw new ApiException(
        400,
        "Unsupported size for this student package account. Use /api/sizes/popular to query available sizes.",
        null
    );
  }

  private String normalizePubKey(Object value) {
    return trimToEmpty(asString(value)).replaceAll("\\s+", " ");
  }

  private String latestTimestamp(String leftRaw, String rightRaw) {
    Instant left = parseDateOrNull(leftRaw);
    Instant right = parseDateOrNull(rightRaw);

    if (left == null) {
      return right == null ? null : right.toString();
    }

    if (right == null) {
      return left.toString();
    }

    return !left.isBefore(right) ? left.toString() : right.toString();
  }

  private Instant parseDateOrNull(String value) {
    String text = trimToEmpty(value);
    if (text.isEmpty()) {
      return null;
    }

    try {
      return Instant.parse(text);
    } catch (Exception ignored) {
      // continue
    }

    try {
      return OffsetDateTime.parse(text).toInstant();
    } catch (Exception ignored) {
      // continue
    }

    try {
      return ZonedDateTime.parse(text).toInstant();
    } catch (Exception ignored) {
      return null;
    }
  }

  private Double numberOrNull(JsonNode node) {
    if (node == null || node.isNull() || node.isMissingNode()) {
      return null;
    }

    if (node.isNumber()) {
      return node.doubleValue();
    }

    if (node.isTextual()) {
      try {
        return Double.parseDouble(node.asText());
      } catch (NumberFormatException ignored) {
        return null;
      }
    }

    return null;
  }

  private int numberToInt(JsonNode node, int fallback) {
    Double value = numberOrNull(node);
    if (value == null) {
      return fallback;
    }
    return (int) Math.round(value);
  }

  private boolean boolOrDefault(JsonNode node, boolean fallback) {
    if (node == null || node.isNull() || node.isMissingNode()) {
      return fallback;
    }

    if (node.isBoolean()) {
      return node.booleanValue();
    }

    if (node.isTextual()) {
      String normalized = trimToEmpty(node.asText()).toLowerCase(Locale.ROOT);
      if ("true".equals(normalized) || "1".equals(normalized) || "yes".equals(normalized)) {
        return true;
      }
      if ("false".equals(normalized) || "0".equals(normalized) || "no".equals(normalized)) {
        return false;
      }
      return fallback;
    }

    if (node.isNumber()) {
      return node.doubleValue() != 0;
    }

    return fallback;
  }

  private double numberOrDefault(String value, double fallback) {
    try {
      return Double.parseDouble(value);
    } catch (Exception ignored) {
      return fallback;
    }
  }

  private double round2(double value) {
    return Math.round(value * 100.0) / 100.0;
  }

  private double round4(double value) {
    return Math.round(value * 10000.0) / 10000.0;
  }

  private double roundUsd(double value) {
    return Math.round(value * 100.0) / 100.0;
  }

  private Object nodeToValueOrNull(JsonNode node) {
    if (node == null || node.isNull() || node.isMissingNode()) {
      return null;
    }
    return objectMapper.convertValue(node, Object.class);
  }

  private Long toLongOrNull(Object value) {
    if (value == null) {
      return null;
    }

    if (value instanceof Number number) {
      return number.longValue();
    }

    try {
      return Long.parseLong(value.toString());
    } catch (Exception ignored) {
      return null;
    }
  }

  private String textOrNull(JsonNode node) {
    if (node == null || node.isNull() || node.isMissingNode()) {
      return null;
    }

    if (node.isTextual()) {
      String text = trimToEmpty(node.asText());
      return text.isEmpty() ? null : text;
    }

    if (node.isNumber() || node.isBoolean()) {
      return node.asText();
    }

    return null;
  }

  private String asString(Object value) {
    if (value == null) {
      return "";
    }

    if (value instanceof JsonNode node) {
      if (node.isTextual() || node.isNumber() || node.isBoolean()) {
        return node.asText();
      }
      return "";
    }

    return Objects.toString(value, "");
  }

  private String firstNonBlank(String... values) {
    for (String value : values) {
      String normalized = trimToEmpty(value);
      if (!normalized.isEmpty()) {
        return normalized;
      }
    }

    return null;
  }

  private String trimToEmpty(String value) {
    return value == null ? "" : value.trim();
  }

  private String encodePathSegment(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
  }

  private record CreditsCache(Map<String, Object> value, long expiresAt) {
  }

  private record InvoiceData(List<JsonNode> invoices, JsonNode invoicePreview) {
  }

  private record DirectCredits(String key, double value) {
  }

  private record SizeCache(List<SizeOption> value, long expiresAt) {
  }

  private record SizeOption(
      String slug,
      String category,
      int memoryMb,
      int vcpus,
      int diskGb,
      double transferTb,
      double monthlyUsd,
      double hourlyUsd,
      boolean available,
      List<String> regions
  ) {
    private boolean matches(String keyword) {
      String searchable = (
          slug + " "
              + category + " "
              + memoryMb + "mb "
              + memoryGbDisplay() + "gb "
              + vcpus + "vcpu "
              + "$" + monthlyUsd + " "
              + "ssd " + diskGb + "gb"
      ).toLowerCase(Locale.ROOT);
      return searchable.contains(keyword);
    }

    private Map<String, Object> toView(boolean recommended) {
      Map<String, Object> item = new LinkedHashMap<>();
      item.put("slug", slug);
      item.put("category", category);
      item.put("memoryGb", memoryGbDisplay());
      item.put("memoryMb", memoryMb);
      item.put("vcpus", vcpus);
      item.put("diskGb", diskGb);
      item.put("transferTb", transferTb);
      item.put("monthlyUsd", monthlyUsd);
      item.put("hourlyUsd", hourlyUsd);
      item.put("available", available);
      item.put("regions", regions);
      item.put("recommended", recommended);
      item.put("label", label());
      return item;
    }

    private String label() {
      return slug + " · " + vcpus + " vCPU / " + memoryGbDisplay() + "GB · $" + monthlyUsd + "/mo";
    }

    private double memoryGbDisplay() {
      return Math.round((memoryMb / 1024.0) * 100.0) / 100.0;
    }
  }
}
