package com.example.docontrolpanel;

public class ApiException extends RuntimeException {

  private final int status;
  private final Object payload;

  public ApiException(int status, String message, Object payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }

  public int getStatus() {
    return status;
  }

  public Object getPayload() {
    return payload;
  }
}
