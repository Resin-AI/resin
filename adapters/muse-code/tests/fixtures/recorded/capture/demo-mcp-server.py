import sys,json
def send(o): sys.stdout.write(json.dumps(o)+"\n"); sys.stdout.flush()
for line in sys.stdin:
    m=json.loads(line); i=m.get("id")
    meth=m.get("method")
    if meth=="initialize": send({"jsonrpc":"2.0","id":i,"result":{"protocolVersion":m["params"].get("protocolVersion","2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"demo","version":"1"}}})
    elif meth=="tools/list": send({"jsonrpc":"2.0","id":i,"result":{"tools":[{"name":"add","description":"Add two numbers","inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}}]}})
    elif meth=="tools/call": a=m["params"]["arguments"]; send({"jsonrpc":"2.0","id":i,"result":{"content":[{"type":"text","text":str(a["a"]+a["b"])}]}})
    elif i is not None: send({"jsonrpc":"2.0","id":i,"result":{}})
