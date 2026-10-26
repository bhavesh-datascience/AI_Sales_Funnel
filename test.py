
from langchain_ollama import ChatOllama
from langchain.agents import create_agent

model = ChatOllama(
    model="qwen3:8b",
    base_url="http://127.0.0.1:11434" )

# agent = create_agent(
#     model=model,
#     tools=[],
#     system_prompt="You are a helpful assistant."
# )

# response = agent.invoke({
#     "messages": [
#         {"role": "user", "content": "Hey!"}
#     ]
# })

# print(response["messages"])


print(model.invoke("hey"))
