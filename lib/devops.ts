import cdk = require("@aws-cdk/core");
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import ec2 = require("@aws-cdk/aws-ec2");
import asg = require("@aws-cdk/aws-autoscaling");
import s3 = require("@aws-cdk/aws-s3");
import codecommit = require("@aws-cdk/aws-codecommit");
import codebuild = require("@aws-cdk/aws-codebuild");
import codedeploy = require("@aws-cdk/aws-codedeploy");
import codepipeline = require("@aws-cdk/aws-codepipeline");
import codepipeline_actions = require("@aws-cdk/aws-codepipeline-actions");
import iam = require("@aws-cdk/aws-iam");
import sns = require("@aws-cdk/aws-sns");
import sns_subscriptions = require("@aws-cdk/aws-sns-subscriptions");
import targets = require("@aws-cdk/aws-events-targets");

export interface DevOpsPipelineStackProps extends cdk.StackProps {
  readonly codecommit_repo: string;
  readonly codecommit_branch: string;
  readonly codebuild_project: string;
  readonly codepipeline_name: string;
  readonly notifications_email: string;
  readonly bucket_name: string;
}

export class DevOpsPipelineStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: DevOpsPipelineStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 1,
    });

    // Get the VPC's public subnets distinct by AZ
    const distinctAzPublicSubnets = Object.values(
      vpc.publicSubnets
      .reduce((map: {[key: string]: ec2.ISubnet}, subnet) => { 
        map[subnet.availabilityZone] = subnet; 
        return map; 
      }, {})
    );

    /**
     * EC2
     */
    const userData = ec2.UserData.forLinux();
    userData.addCommands(...[
      'yum update -y',
      'yum install -y httpd ruby wget jq',
      'systemctl start httpd',
      'systemctl enable httpd',
      // install codedeploy-agent
      'cd /tmp',
      'wget https://aws-codedeploy-us-east-1.s3.us-east-1.amazonaws.com/latest/install',
      'chmod +x ./install',
      './install auto',
      'systemctl start codedeploy-agent',
      'systemctl enable codedeploy-agent'
    ]);
    userData.render();

    // const webSG = new ec2.SecurityGroup(this, 'WebAppServerSecurityGroup', {
    //   vpc
    // });

    // const albSG = new ec2.SecurityGroup(this, 'WebAppALBSecurityGroup', {
    //   vpc
    // });
    const instanceRole = new iam.Role(this, 'WebAppRole', {
      assumedBy: new iam.ServicePrincipal('ec2'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforSSM')],
    })

    // Pull the standard Amazon Linux 2 AMI
    const amznLinuxAmi = new ec2.AmazonLinuxImage({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      edition: ec2.AmazonLinuxEdition.STANDARD,
      virtualization: ec2.AmazonLinuxVirt.HVM,
      storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE,
    });

    const instanceAsg = new asg.AutoScalingGroup(this, 'WebAppASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: amznLinuxAmi,
      userData: userData,
      minCapacity: 1,
      maxCapacity: 6,
      vpcSubnets: vpc.selectSubnets({
        subnets: distinctAzPublicSubnets,
      }),
      role: instanceRole,
    });

    // Application ELB
    const lb = new elbv2.ApplicationLoadBalancer(this, 'WebELB', {
      vpc,
      internetFacing: true,
      vpcSubnets: vpc.selectSubnets({
        subnets: distinctAzPublicSubnets,
      }),
    });

    // Configure ELB listener
    const listener = lb.addListener('WebListener', {
      port: 80,
    });
    const listenerTargets = listener.addTargets('WebTarget', {
      port: 80,
      deregistrationDelay: cdk.Duration.seconds(15),
      healthCheck: {
        interval: cdk.Duration.seconds(31),
        timeout: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
      targets: [instanceAsg]
    });
    listener.connections.allowDefaultPortFromAnyIpv4('Open to the world (ALLOW 80 0.0.0.0/0,::0)');


    // Bucket of source code
    const bucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: props.bucket_name
    });

    /** 
     * CodeCommit: create repository
    **/ 
    const codecommitRepository = new codecommit.Repository(this, "SourceRepo", {
      repositoryName: props.codecommit_repo
    });

    /**
     * CodeBuild: 
    **/
    const codebuildProject = new codebuild.PipelineProject(this, "Build", {
      projectName: props.codebuild_project,
      environment: {
        computeType: codebuild.ComputeType.SMALL,
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        privileged: true,
        environmentVariables: {
          AWS_ACCOUNT_ID: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: cdk.Aws.ACCOUNT_ID
          },
          AWS_DEFAULT_REGION: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: cdk.Aws.REGION
          }
        }
      }
    });

    // codebuild policy of codecommit pull source code.
    const codeBuildPolicyOfcodeCommit = new iam.PolicyStatement();
    codeBuildPolicyOfcodeCommit.addResources(codecommitRepository.repositoryArn)
    codeBuildPolicyOfcodeCommit.addActions(
      "codecommit:ListBranches",
      "codecommit:ListRepositories",
      "codecommit:BatchGetRepositories",
      "codecommit:GitPull"
    );
    codebuildProject.addToRolePolicy(
      codeBuildPolicyOfcodeCommit,
    );

    // codebuild policy of codecommit pull source code.
    const codeBuildPolicyOfBucket = new iam.PolicyStatement();
    codeBuildPolicyOfBucket.addResources(bucket.bucketArn)
    codeBuildPolicyOfBucket.addActions("s3:*");
    codebuildProject.addToRolePolicy(
      codeBuildPolicyOfBucket,
    );

    /**
     * CodeDeploy 
     */
    const role = new iam.Role(this, "CodeDeployRole", {
      assumedBy: new iam.ServicePrincipal("codedeploy.amazonaws.com"),
    });

    role.addManagedPolicy(iam.
      ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSCodeDeployRole'))

    const app = new codedeploy.ServerApplication(this, "Application", {
        applicationName: "WebApp",
    });

    const deploymentGroup = new codedeploy.ServerDeploymentGroup(this, "DeploymentGroup", {
        application: app,
        role,
        deploymentGroupName: "master",
        installAgent: true,
        loadBalancer: codedeploy.LoadBalancer.application(listenerTargets),
        autoScalingGroups: [instanceAsg],
        onPremiseInstanceTags: new codedeploy.InstanceTagSet({
          App: ["WebServer"],
        }),
        autoRollback: {
          failedDeployment: true,
          stoppedDeployment: true,
          deploymentInAlarm: false,
        },
      }
    );

    /**
     * CodePipeline: 
    **/
    // trigger of `CodeCommitTrigger.POLL`
    const sourceOutput = new codepipeline.Artifact();
    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: "Source",
      branch: props.codecommit_branch,
      trigger: codepipeline_actions.CodeCommitTrigger.POLL,
      repository: codecommitRepository,
      output: sourceOutput
    });

    // Manual approval action
    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'DeployApproval',
      notifyEmails: [
        props.notifications_email
      ],
    });

    // when codecommit input then action of codebuild
    const buildOutput = new codepipeline.Artifact();
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "Build",
      input: sourceOutput,
      outputs: [
        buildOutput
      ],
      project: codebuildProject
    });

    // when codebuild input then action of codedeploy
    const deployAction = new codepipeline_actions.CodeDeployServerDeployAction({
      actionName: "Deploy",
      input: buildOutput,
      deploymentGroup: deploymentGroup
    });

    // create pipeline, and then add both codecommit and codebuild  
    const pipeline = new codepipeline.Pipeline(this, "DevOpsPipeline", {
      pipelineName: props.codepipeline_name
    });
    pipeline.addStage({
      stageName: "Source",
      actions: [sourceAction]
    });
    pipeline.addStage({
      stageName: "Build",
      actions: [buildAction]
    });
    pipeline.addStage({
      stageName: "Approve",
      actions: [manualApprovalAction]
    });
    pipeline.addStage({
      stageName: "Deploy",
      actions: [deployAction]
    });

    /**
     * SNS: Monitor pipeline state change then notifiy
    **/
    const pipelineSnsTopic = new sns.Topic(this, 'DevOpsPipelineStageChange');
    pipelineSnsTopic.addSubscription(new sns_subscriptions.EmailSubscription(props.notifications_email))
    pipeline.onStateChange("DevOpsPipelineStateChange", {
      target: new targets.SnsTopic(pipelineSnsTopic), 
      description: 'Listen for codepipeline change events',
      eventPattern: {
        detail: {
          state: [ 'FAILED', 'SUCCEEDED', 'STOPPED' ]
        }
      }
    });



  }
}
