package com.example;

import java.util.List;
import org.springframework.http.ResponseEntity;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;

public class App {
    private static final Logger logger = LoggerFactory.getLogger(App.class);

    public List<String> getItems() {
        return List.of("a", "b");
    }

    public ResponseEntity<String> getResponse() {
        return ResponseEntity.ok("hello");
    }

    public void traceOperation(Tracer tracer) {
        Span span = tracer.spanBuilder("op").startSpan();
        logger.info("tracing");
        span.end();
    }
}
