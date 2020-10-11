#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import { DevOpsPipelineStack } from '../lib/devops';

const app = new cdk.App();

new DevOpsPipelineStack(app, 'DevOpsPipeline', {
  codecommit_repo: app.node.tryGetContext('codecommit_repo'),
  codecommit_branch: app.node.tryGetContext('codecommit_branch'),
  codebuild_project: app.node.tryGetContext('codebuild_project'),
  codepipeline_name: app.node.tryGetContext('codepipeline_name'),
  notifications_email: app.node.tryGetContext('notifications_email'),
  bucket_name: app.node.tryGetContext('bucket_name'),
});
