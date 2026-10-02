import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const tick=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/cron-tick",()=>({runTick:tick}));
vi.mock("@/lib/services",()=>({isDbMode:()=>true}));
vi.mock("@/lib/services/db",()=>({getDb:()=>({})}));
import {POST} from "./route";
const request=(secret="test-cron")=>new Request("https://curvi.ai/api/cron/tick",{method:"POST",headers:{authorization:`Bearer ${secret}`}});
beforeEach(()=>{vi.stubEnv("CRON_SECRET","test-cron");tick.mockReset();});
afterEach(()=>vi.unstubAllEnvs());
describe("tick route",()=>{
 it("fails closed before starting work",async()=>{
  expect((await POST(request("wrong"))).status).toBe(401);
  vi.stubEnv("CRON_SECRET","");expect((await POST(request())).status).toBe(503);
  expect(tick).not.toHaveBeenCalled();
 });
 it.each([["held",[],false,200],["stuck",[],false,503],["ran",["retention"],false,503],["ran",[],true,503],["ran",[],false,200]] as const)("reports %s with failures=%j budget=%s",async(status,failed,budgetExhausted,expected)=>{
  tick.mockResolvedValue({status,failed,succeeded:[],deferred:[],budgetExhausted});
  const response=await POST(request());expect(response.status).toBe(expected);
  expect(response.headers.get("cache-control")).toBe("no-store");
 });
});
