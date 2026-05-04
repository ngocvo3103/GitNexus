/**
 * Unit Tests: Document Endpoint — Messaging Trigger
 *
 * Tests: extractMessaging uses node.name as trigger instead of hardcoded TODO_AI_ENRICH.
 *
 * Test Design Techniques:
 * - Decision Table: trigger source (node.name vs TODO_AI_ENRICH)
 * - Integration: payload flows through extractMessaging to document output
 * - Regression: publishEvent unchanged
 *
 * Feature: messaging trigger
 *   As a document-endpoint consumer
 *   I want outbound messages to show the enclosing method name as trigger
 *   So I can trace which method initiated each outbound message
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Module under test
import { extractMessaging } from '../../src/mcp/local/document-endpoint.js';
import type { ChainNode, MessagingOutbound } from '../../src/mcp/local/document-endpoint.js';

describe('WI-1: Messaging Trigger', () => {
  describe('trigger_uses_method_name', () => {
    it('sets trigger to node.name for outbound messages', async () => {
      // Create a chain node with a known method name
      const chain: ChainNode[] = [
        {
          uid: 'processOrder-meth',
          name: 'processOrder',
          filePath: 'OrderService.java',
          startLine: 10,
          endLine: 20,
          depth: 0,
          kind: 'Method',
          type: 'Method',
          content: 'public void processOrder(OrderDto order) { rabbitTemplate.convertAndSend("exchange", "key", order); }',
          annotations: [],
          parameterAnnotations: [],
          parameterCount: 1,
          fields: [],
          resolvedFrom: null,
          isInterface: false,
          returnType: 'void',
          callees: [],
          metadata: {
            httpCalls: [],
            httpCallDetails: [],
            annotations: [],
            eventPublishing: [],
            messagingDetails: [
              {
                topic: 'exchange',
                topicIsVariable: false,
                callerMethod: 'convertAndSend',
                payload: 'OrderDto',
              },
            ],
            repositoryCalls: [],
            repositoryCallDetails: [],
            valueProperties: [],
            exceptions: [],
            builderDetails: [],
          },
        },
      ];

      const result = await extractMessaging(chain, false);

      expect(result.outbound).toHaveLength(1);
      expect(result.outbound[0].trigger).toBe('processOrder');
      expect(result.outbound[0].payload).toBe('OrderDto');
      expect(result.outbound[0].topic).toBe('exchange');
    });

    it('falls back to TODO_AI_ENRICH when node.name is undefined', async () => {
      const chain: ChainNode[] = [
        {
          uid: 'unknown-node',
          name: undefined as unknown as string,
          filePath: 'Unknown.java',
          startLine: 1,
          endLine: 10,
          depth: 0,
          kind: 'Method',
          type: 'Method',
          content: '',
          annotations: [],
          parameterAnnotations: [],
          parameterCount: 0,
          fields: [],
          resolvedFrom: null,
          isInterface: false,
          returnType: 'void',
          callees: [],
          metadata: {
            httpCalls: [],
            httpCallDetails: [],
            annotations: [],
            eventPublishing: [],
            messagingDetails: [
              {
                topic: 'exchange',
                topicIsVariable: false,
                callerMethod: 'convertAndSend',
                payload: 'OrderDto',
              },
            ],
            repositoryCalls: [],
            repositoryCallDetails: [],
            valueProperties: [],
            exceptions: [],
            builderDetails: [],
          },
        },
      ];

      const result = await extractMessaging(chain, false);

      expect(result.outbound).toHaveLength(1);
      expect(result.outbound[0].trigger).toBe('TODO_AI_ENRICH');
    });
  });

  describe('payload_flows_to_document_output', () => {
    it('payload from messaging detail flows through to outbound array', async () => {
      const chain: ChainNode[] = [
        {
          uid: 'sendOrder-meth',
          name: 'sendOrder',
          filePath: 'OrderService.java',
          startLine: 15,
          endLine: 25,
          depth: 0,
          kind: 'Method',
          type: 'Method',
          content: 'public void sendOrder(OrderDto order) { kafkaTemplate.send("order-topic", order); }',
          annotations: [],
          parameterAnnotations: [],
          parameterCount: 1,
          fields: [],
          resolvedFrom: null,
          isInterface: false,
          returnType: 'void',
          callees: [],
          metadata: {
            httpCalls: [],
            httpCallDetails: [],
            annotations: [],
            eventPublishing: [],
            messagingDetails: [
              {
                topic: 'order-topic',
                topicIsVariable: false,
                callerMethod: 'kafkaTemplate.send',
                payload: 'OrderDto',
              },
            ],
            repositoryCalls: [],
            repositoryCallDetails: [],
            valueProperties: [],
            exceptions: [],
            builderDetails: [],
          },
        },
      ];

      const result = await extractMessaging(chain, false);

      expect(result.outbound).toHaveLength(1);
      const outbound = result.outbound[0];
      expect(outbound.topic).toBe('order-topic');
      expect(outbound.payload).toBe('OrderDto');
      expect(outbound.trigger).toBe('sendOrder');
    });

    it('multiple outbound messages from same node have correct triggers', async () => {
      const chain: ChainNode[] = [
        {
          uid: 'notify-meth',
          name: 'notify',
          filePath: 'NotificationService.java',
          startLine: 5,
          endLine: 30,
          depth: 0,
          kind: 'Method',
          type: 'Method',
          content: 'public void notify() { kafkaTemplate.send("email-topic", emailDto); streamBridge.send("sms-binding", smsDto); }',
          annotations: [],
          parameterAnnotations: [],
          parameterCount: 0,
          fields: [],
          resolvedFrom: null,
          isInterface: false,
          returnType: 'void',
          callees: [],
          metadata: {
            httpCalls: [],
            httpCallDetails: [],
            annotations: [],
            eventPublishing: [],
            messagingDetails: [
              {
                topic: 'email-topic',
                topicIsVariable: false,
                callerMethod: 'kafkaTemplate.send',
                payload: 'EmailDto',
              },
              {
                topic: 'sms-binding',
                topicIsVariable: false,
                callerMethod: 'streamBridge.send',
                payload: 'SmsDto',
              },
            ],
            repositoryCalls: [],
            repositoryCallDetails: [],
            valueProperties: [],
            exceptions: [],
            builderDetails: [],
          },
        },
      ];

      const result = await extractMessaging(chain, false);

      expect(result.outbound).toHaveLength(2);

      const kafkaOutbound = result.outbound.find(o => o.topic === 'email-topic');
      expect(kafkaOutbound).toBeDefined();
      expect(kafkaOutbound!.payload).toBe('EmailDto');
      expect(kafkaOutbound!.trigger).toBe('notify');

      const streamOutbound = result.outbound.find(o => o.topic === 'sms-binding');
      expect(streamOutbound).toBeDefined();
      expect(streamOutbound!.payload).toBe('SmsDto');
      expect(streamOutbound!.trigger).toBe('notify');
    });
  });

  describe('regression: publishEvent unchanged', () => {
    it('publishEvent payload still flows correctly with node.name as trigger', async () => {
      const chain: ChainNode[] = [
        {
          uid: 'onOrderCreated-meth',
          name: 'onOrderCreated',
          filePath: 'OrderListener.java',
          startLine: 20,
          endLine: 30,
          depth: 0,
          kind: 'Method',
          type: 'Method',
          content: 'public void onOrderCreated(OrderCreatedEvent event) { applicationEventPublisher.publishEvent(event); }',
          annotations: [],
          parameterAnnotations: [],
          parameterCount: 1,
          fields: [],
          resolvedFrom: null,
          isInterface: false,
          returnType: 'void',
          callees: [],
          metadata: {
            httpCalls: [],
            httpCallDetails: [],
            annotations: [],
            eventPublishing: [],
            messagingDetails: [
              {
                topic: 'order-created',
                topicIsVariable: false,
                callerMethod: 'publishEvent',
                payload: 'OrderCreatedEvent',
              },
            ],
            repositoryCalls: [],
            repositoryCallDetails: [],
            valueProperties: [],
            exceptions: [],
            builderDetails: [],
          },
        },
      ];

      const result = await extractMessaging(chain, false);

      expect(result.outbound).toHaveLength(1);
      const outbound = result.outbound[0];
      expect(outbound.topic).toBe('order-created');
      expect(outbound.payload).toBe('OrderCreatedEvent');
      expect(outbound.trigger).toBe('onOrderCreated');
    });
  });
});
