/**
 * Unit Tests: Trace Executor — Messaging Payload Extraction
 *
 * Tests: extractMetadata captures payload argument from convertAndSend/kafka/stream patterns.
 *
 * Test Design Techniques:
 * - Equivalence Partitioning: 3-arg, 2-arg, 1-arg convertAndSend; literal/variable topics
 * - Boundary Value Analysis: empty payload, single arg
 * - Regression: publishEvent unchanged
 *
 * Feature: messaging payload extraction
 *   As a trace analyst
 *   I want to capture the payload argument from outbound messaging calls
 *   So that document-endpoint can show actual payload types (e.g. "OrderDto")
 */
import { describe, it, expect } from 'vitest';

// Module under test — test extractMetadata directly (cleaner than executeTrace)
import { extractMetadata } from '../../src/mcp/local/trace-executor.js';
import type { ChainNode } from '../../src/mcp/local/trace-executor.js';

describe('WI-1: Messaging Payload Extraction', () => {
  describe('convertAndSend_3args_captures_payload', () => {
    it('captures payload from convertAndSend("exchange", "key", orderDto)', () => {
      // 3-arg form: convertAndSend(exchange, routingKey, payload)
      const content = `public void processOrder(OrderDto order) {
        rabbitTemplate.convertAndSend("exchange.order", "routing.key", order);
      }`;

      const metadata = extractMetadata(content);
      const detail = metadata.messagingDetails.find(
        d => d.callerMethod === 'convertAndSend' && d.topic === 'exchange.order'
      );

      expect(detail).toBeDefined();
      // Payload should be 'order' (the variable name), not 'orderDto' (the type)
      expect(detail!.payload).toBe('order');
      expect(detail!.topic).toBe('exchange.order');
      expect(detail!.topicIsVariable).toBe(false);
    });

    // Note: FQCNs like com.example.OrderDto are not matched by the payload pattern
    // because dots in the payload expression break the [\w]+ match. This is a known
    // limitation — variable names (order, orderDto) are captured correctly.
  });

  describe('convertAndSend_2args_captures_payload', () => {
    it('captures payload from convertAndSend("key", orderDto) — no exchange', () => {
      // 2-arg form: convertAndSend(routingKey, payload)
      const content = `public void processOrder(OrderDto order) {
        rabbitTemplate.convertAndSend("routing.key", order);
      }`;

      const metadata = extractMetadata(content);
      const detail = metadata.messagingDetails.find(
        d => d.callerMethod === 'convertAndSend' && d.topic === 'routing.key'
      );

      expect(detail).toBeDefined();
      expect(detail!.payload).toBe('order');
    });
  });

  describe('convertAndSend_1arg_no_payload', () => {
    it('handles convertAndSend with single arg — no payload captured', () => {
      // 1-arg form: convertAndSend(message) — our pattern doesn't capture this
      const content = `public void sendMessage(Object message) {
        rabbitTemplate.convertAndSend(message);
      }`;

      const metadata = extractMetadata(content);
      // No literal topic match in 1-arg form, so no messagingDetail
      // (this is expected — 1-arg form uses a variable as the topic+payload combined)
      expect(metadata.messagingDetails.length).toBe(0);
    });
  });

  describe('kafka_send_captures_payload', () => {
    it('captures payload from kafkaTemplate.send("topic", orderDto)', () => {
      const content = `public void sendOrder(OrderDto order) {
        kafkaTemplate.send("order-topic", order);
      }`;

      const metadata = extractMetadata(content);
      const detail = metadata.messagingDetails.find(
        d => d.callerMethod === 'kafkaTemplate.send' && d.topic === 'order-topic'
      );

      expect(detail).toBeDefined();
      expect(detail!.payload).toBe('order');
      expect(detail!.topicIsVariable).toBe(false);
    });

    it('captures payload from kafkaTemplate.send with single-quoted topic', () => {
      const content = `public void sendOrder(OrderDto order) {
        kafkaTemplate.send('order-topic', order);
      }`;

      const metadata = extractMetadata(content);
      const detail = metadata.messagingDetails.find(
        d => d.callerMethod === 'kafkaTemplate.send' && d.topic === 'order-topic'
      );

      expect(detail).toBeDefined();
      expect(detail!.payload).toBe('order');
    });
  });

  describe('stream_send_captures_payload', () => {
    it('captures payload from streamBridge.send("binding", orderDto)', () => {
      const content = `public void streamOrder(OrderDto order) {
        streamBridge.send("order-binding", order);
      }`;

      const metadata = extractMetadata(content);
      const detail = metadata.messagingDetails.find(
        d => d.callerMethod === 'streamBridge.send' && d.topic === 'order-binding'
      );

      expect(detail).toBeDefined();
      expect(detail!.payload).toBe('order');
      expect(detail!.topicIsVariable).toBe(false);
    });

    it('captures payload from streamBridge.send with single-quoted binding', () => {
      const content = `public void streamOrder(OrderDto order) {
        streamBridge.send('order-binding', order);
      }`;

      const metadata = extractMetadata(content);
      const detail = metadata.messagingDetails.find(
        d => d.callerMethod === 'streamBridge.send' && d.topic === 'order-binding'
      );

      expect(detail).toBeDefined();
      expect(detail!.payload).toBe('order');
    });
  });

  describe('publishEvent_regression', () => {
    it('publishEvent payload extraction unchanged', () => {
      const content = `public void handleCreated(OrderCreatedEvent event) {
        applicationEventPublisher.publishEvent(new OrderCreatedEvent(event));
      }`;

      const metadata = extractMetadata(content);
      const detail = metadata.messagingDetails.find(
        d => d.callerMethod === 'publishEvent'
      );

      expect(detail).toBeDefined();
      // publishEvent with new XxxEvent(...) should have payload = "XxxEvent"
      expect(detail!.payload).toBe('OrderCreatedEvent');
      // Topic should be kebab-case of event class name (without "Event" suffix)
      expect(detail!.topic).toBe('order-created');
    });

    it('publishEvent with variable payload — local variable form', () => {
      // Test the existing variable-based publishEvent pattern (EVENT_VARIABLE_PATTERN)
      // which requires a local variable declaration, not a method parameter.
      const content = `public void handleCreated(OrderCreatedEvent event) {
        OrderCreatedEvent orderEvent = new OrderCreatedEvent();
        applicationEventPublisher.publishEvent(orderEvent);
      }`;

      const metadata = extractMetadata(content);
      const detail = metadata.messagingDetails.find(
        d => d.callerMethod === 'publishEvent'
      );

      // The existing variable-based publishEvent pattern should capture this
      expect(detail).toBeDefined();
      expect(detail!.topic).toBe('order-created');
    });
  });

  describe('payload_deduplication', () => {
    it('does not duplicate when same call appears multiple times', () => {
      const content = `public void processOrder(OrderDto order) {
        rabbitTemplate.convertAndSend("exchange", "key", order);
        rabbitTemplate.convertAndSend("exchange", "key", order);
      }`;

      const metadata = extractMetadata(content);
      const convertAndSendDetails = metadata.messagingDetails.filter(
        d => d.callerMethod === 'convertAndSend'
      );

      // Should only have one entry despite duplicate calls
      expect(convertAndSendDetails.length).toBe(1);
      expect(convertAndSendDetails[0].payload).toBe('order');
    });
  });

  describe('topic_field_unchanged', () => {
    it('topic field is preserved in all cases', () => {
      const content = `public void sendOrder(OrderDto order) {
        kafkaTemplate.send("order-topic", order);
        streamBridge.send("order-binding", order);
      }`;

      const metadata = extractMetadata(content);

      const kafkaDetail = metadata.messagingDetails.find(
        d => d.callerMethod === 'kafkaTemplate.send'
      );
      const streamDetail = metadata.messagingDetails.find(
        d => d.callerMethod === 'streamBridge.send'
      );

      expect(kafkaDetail!.topic).toBe('order-topic');
      expect(streamDetail!.topic).toBe('order-binding');
    });
  });
});
