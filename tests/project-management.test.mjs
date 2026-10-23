import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import express from "express";
import "dotenv/config";

const databaseName = "hrm_project_test_" + randomUUID().replaceAll("-", "");
process.env.JWT_SESSION_PREFIX = databaseName;
process.env.DB_REDIS_URL = process.env.HRM_TEST_REDIS_URL || process.env.DB_REDIS_URL || "redis://127.0.0.1:6379";
const root = "../tmp/project-test-build/src/";
const { default: registerRoutes } = await import(root + "routes/index.js");
const { Database: Redis } = await import(root + "node-base/baseClasses/Redis/index.js");
const { sendResponseObject } = await import(root + "node-base/utils/index.js");
const { default: User } = await import(root + "AuthModule/models/User.js");
const { default: Employee } = await import(root + "EmployeeModule/models/Employee.js");
const { default: Organization } = await import(root + "OrganizationModule/models/Organization.js");
const { default: Project } = await import(root + "ProjectModule/models/Project.js");
const { default: ProjectMember } = await import(root + "ProjectModule/models/ProjectMember.js");
const { default: ProjectTask } = await import(root + "ProjectModule/models/ProjectTask.js");
const { default: WorkflowStatus } = await import(root + "ProjectModule/models/WorkflowStatus.js");
const { hashPassword } = await import(root + "AuthModule/utils/password.js");
const { generateSessionTokens } = await import(root + "AuthModule/utils/session.js");

test("project management permissions, assignments, transitions and tenant isolation", async () => {
  let server;
  try {
    await mongoose.connect(process.env.HRM_TEST_MONGO_URI || process.env.DB_MONGO_URI || "mongodb://127.0.0.1:27017", { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
    await Redis.initialize();
    await Promise.all([Project.init(), ProjectMember.init(), ProjectTask.init(), WorkflowStatus.init()]);
    const org = await Organization.create({ name:"Project test",slug:"project-test",timezone:"UTC" });
    const otherOrg = await Organization.create({ name:"Other tenant",slug:"other-project-test",timezone:"UTC" });
    async function account(loginId, organizationId, permissions) {
      const user = await User.create({ organizationId, loginId, passwordHash:await hashPassword("Project-test-42"), isActive:true });
      const employee = await Employee.create({ organizationId, userId:user.id, employeeCode:loginId, firstName:loginId, lastName:"Person", workEmail:`${loginId}@test.invalid`, employmentStatus:"active" });
      return { user, employee, ...(await generateSessionTokens({ userId:user.id, employeeId:employee.id, organizationId, permissions, credentialVersion:0 })) };
    }
    const admin=await account("admin",org.id,["*"]), member=await account("member",org.id,["project.read","project.task"]), second=await account("second",org.id,["project.read","project.task"]), outsider=await account("outsider",otherOrg.id,["*"]);
    const app=express();app.use(express.json());registerRoutes(app);app.use((error,_req,res,_next)=>sendResponseObject({res,code:error.statusCode||500,message:error.message,data:error.data||{}}));
    server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));const base=`http://127.0.0.1:${server.address().port}`;
    async function request(path,session,method="GET",data){const response=await fetch(base+path,{method,headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.accessToken}`},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json()}}
    const created=await request("/projects",admin,"POST",{name:"HRM delivery",key:"HRM",managerEmployeeId:admin.employee.id});assert.equal(created.status,201);const projectId=created.body.data.project.id;
    assert.equal((await request(`/projects/${projectId}`,outsider)).status,404);
    assert.equal((await request("/projects",member,"POST",{name:"No",key:"NO",managerEmployeeId:member.employee.id})).status,403);
    assert.equal((await request(`/projects/${projectId}/members`,admin,"POST",{members:[{employeeId:member.employee.id,role:"member"},{employeeId:second.employee.id,role:"member"}]})).status,200);
    const workflow=(await request(`/projects/${projectId}/workflow`,member)).body.data.workflow;const backlog=workflow.find(x=>x.isDefault),progress=workflow.find(x=>x.category==="in_progress"),done=workflow.find(x=>x.category==="done");
    const taskResult=await request(`/projects/${projectId}/tasks`,member,"POST",{title:"Implement attendance API",assigneeEmployeeIds:[member.employee.id,second.employee.id]});assert.equal(taskResult.status,201);const task=taskResult.body.data.task;assert.equal(task.assigneeEmployeeIds.length,2);
    assert.equal((await request(`/projects/${projectId}/tasks`,member,"POST",{title:"Bad assignment",assigneeEmployeeIds:[outsider.employee.id]})).status,422);
    assert.equal((await request(`/projects/${projectId}/tasks/${task.id}/status`,member,"PATCH",{workflowStatusId:done.id})).status,409);
    assert.equal((await request(`/projects/${projectId}/tasks/${task.id}/status`,member,"PATCH",{workflowStatusId:progress.id})).status,200);
    assert.equal((await request(`/projects/${projectId}/tasks/${task.id}/comments`,second,"POST",{body:"Ready for review"})).status,201);
    const detail=await request(`/projects/${projectId}/tasks/${task.id}`,member);assert.equal(detail.body.data.comments.length,1);assert.ok(detail.body.data.activity.some(x=>x.action==="task.status_changed"));
    assert.equal((await request(`/projects/${projectId}/workflow/statuses/${progress.id}`,admin,"DELETE",{})).status,422);
    assert.equal((await request(`/projects/${projectId}/workflow/statuses/${progress.id}`,admin,"DELETE",{replacementStatusId:backlog.id})).status,200);
    assert.equal((await request(`/projects/${projectId}/members/${member.employee.id}`,admin,"DELETE",{})).status,409);
    assert.equal((await request(`/projects/${projectId}/members/${member.employee.id}`,admin,"DELETE",{confirmUnassign:true})).status,200);
    const historical=await ProjectTask.findById(task.id);assert.ok(historical);assert.deepEqual(historical.assigneeEmployeeIds,[second.employee.id]);
  } finally { if(server)await new Promise(resolve=>server.close(resolve));await mongoose.connection.dropDatabase().catch(()=>{});await mongoose.disconnect().catch(()=>{});await Redis.close().catch(()=>{}); }
});
