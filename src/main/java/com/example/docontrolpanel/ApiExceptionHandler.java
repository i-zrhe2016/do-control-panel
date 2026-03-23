package com.example.docontrolpanel;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {

  @ExceptionHandler(ApiException.class)
  public ResponseEntity<Map<String, Object>> handleApiException(ApiException ex) {
    return ResponseEntity.status(ex.getStatus()).body(errorBody(ex.getMessage(), ex.getPayload()));
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ResponseEntity<Map<String, Object>> handleInvalidJson(HttpMessageNotReadableException ex) {
    return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(errorBody("Invalid JSON body", null));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String, Object>> handleUnexpected(Exception ex) {
    String message = ex.getMessage() == null || ex.getMessage().isBlank()
        ? "Internal server error"
        : ex.getMessage();

    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorBody(message, null));
  }

  private Map<String, Object> errorBody(String message, Object details) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("error", message == null || message.isBlank() ? "Internal server error" : message);
    body.put("details", details);
    return body;
  }
}
