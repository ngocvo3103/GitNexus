Let's wipe the current index of tcbs-bond-trading and reindex this project and all of its external dependencies
- /Users/NgocVo_1/Documents/sourceCode/tcbs-bond-trading
- /Users/NgocVo_1/Documents/sourceCode/bond-exception-handler
- /Users/NgocVo_1/Documents/sourceCode/matching-engine-client
- /Users/NgocVo_1/Documents/sourceCode/tcbs-bond-amqp
- /Users/NgocVo_1/Documents/sourceCode/tcbs-bond-amqp-message
- /Users/NgocVo_1/Documents/sourceCode/tcbs-bond-trading-core

Then we test the `document-endpoint` tool with endpoint `PUT /e/v1/bookings/{productCode}/suggest`, output the file with and without context to `/Users/NgocVo_1/Documents/sourceCode/GitNexus/gitnexus/docs/tmp`. Make sure all the external dependencies (api, message) are correctly looked up and resolved recursively, the validation is properly populated.

Verify the `document-endpoint` tool in all output options

  IMPORTANT: 
  - If something doesn't work as expected, DO NOT try to fix. Instead do thorough investigation,
  output the issue and your findings to
  `/Users/NgocVo_1/Documents/sourceCode/GitNexus/gitnexus/docs/bug` so that we can think about the fix
  deeply
  - List all test output files with their path and size for user to review
  - List number of indexed nodes, including route node
