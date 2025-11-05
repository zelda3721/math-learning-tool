"""
知识图谱可视化工具
用于可视化知识点之间的依赖关系和学习路径
"""
import logging
from typing import Dict, Any, List, Optional, Tuple
import networkx as nx
import matplotlib.pyplot as plt
import plotly.graph_objects as go
from matplotlib import font_manager
import io
import base64

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class KnowledgeGraphVisualizer:
    """知识图谱可视化器"""

    def __init__(self, font_path: Optional[str] = None):
        """
        初始化可视化器

        Args:
            font_path: 中文字体路径，None时使用默认
        """
        self.graph = nx.DiGraph()

        # 配置中文字体
        if font_path:
            self.font_prop = font_manager.FontProperties(fname=font_path)
        else:
            # 尝试使用系统字体
            try:
                self.font_prop = font_manager.FontProperties(family='SimHei')
            except:
                logger.warning("Chinese font not found, using default")
                self.font_prop = None

    def build_graph(self, knowledge_points: List[Dict[str, Any]]) -> nx.DiGraph:
        """
        从知识点列表构建图

        Args:
            knowledge_points: 知识点列表

        Returns:
            NetworkX有向图
        """
        self.graph.clear()

        # 添加节点
        for kp in knowledge_points:
            kp_id = kp.get("id", "")
            if not kp_id:
                continue

            self.graph.add_node(
                kp_id,
                title=kp.get("title", ""),
                type=kp.get("type", "unknown"),
                importance=kp.get("importance", "medium"),
                difficulty=kp.get("difficulty", "intermediate")
            )

        # 添加边（依赖关系）
        for kp in knowledge_points:
            kp_id = kp.get("id", "")
            prerequisites = kp.get("prerequisites", [])

            for prereq in prerequisites:
                # 查找前置知识点的ID
                prereq_id = None

                # 如果是ID格式
                if prereq.startswith("kp_"):
                    prereq_id = prereq
                else:
                    # 按标题查找
                    for other_kp in knowledge_points:
                        if prereq.lower() in other_kp.get("title", "").lower():
                            prereq_id = other_kp.get("id", "")
                            break

                if prereq_id and prereq_id in self.graph.nodes:
                    self.graph.add_edge(prereq_id, kp_id)

        logger.info(f"Built knowledge graph: {self.graph.number_of_nodes()} nodes, {self.graph.number_of_edges()} edges")

        return self.graph

    def visualize_matplotlib(
        self,
        figsize: Tuple[int, int] = (12, 8),
        save_path: Optional[str] = None
    ) -> str:
        """
        使用Matplotlib生成静态图

        Args:
            figsize: 图片尺寸
            save_path: 保存路径，None时返回base64编码

        Returns:
            图片路径或base64编码
        """
        plt.figure(figsize=figsize)

        # 使用分层布局
        try:
            pos = nx.spring_layout(self.graph, k=2, iterations=50)
        except:
            pos = nx.random_layout(self.graph)

        # 节点颜色映射
        importance_colors = {
            "high": "#e74c3c",
            "medium": "#f39c12",
            "low": "#95a5a6"
        }

        node_colors = [
            importance_colors.get(self.graph.nodes[node].get("importance", "medium"), "#3498db")
            for node in self.graph.nodes
        ]

        # 节点大小
        node_sizes = [
            3000 if self.graph.nodes[node].get("importance") == "high" else 2000
            for node in self.graph.nodes
        ]

        # 绘制图
        nx.draw_networkx_nodes(
            self.graph, pos,
            node_color=node_colors,
            node_size=node_sizes,
            alpha=0.8
        )

        nx.draw_networkx_edges(
            self.graph, pos,
            edge_color='gray',
            arrows=True,
            arrowsize=20,
            alpha=0.5,
            arrowstyle='->'
        )

        # 标签
        labels = {
            node: self.graph.nodes[node].get("title", node)[:10]  # 限制长度
            for node in self.graph.nodes
        }

        if self.font_prop:
            nx.draw_networkx_labels(
                self.graph, pos,
                labels=labels,
                font_size=9,
                font_family=self.font_prop.get_family()
            )
        else:
            nx.draw_networkx_labels(
                self.graph, pos,
                labels=labels,
                font_size=9
            )

        plt.title("知识点依赖图", fontsize=16, fontproperties=self.font_prop)
        plt.axis('off')
        plt.tight_layout()

        # 保存或返回
        if save_path:
            plt.savefig(save_path, dpi=150, bbox_inches='tight')
            plt.close()
            return save_path
        else:
            # 转为base64
            buf = io.BytesIO()
            plt.savefig(buf, format='png', dpi=150, bbox_inches='tight')
            plt.close()
            buf.seek(0)
            img_base64 = base64.b64encode(buf.read()).decode()
            return f"data:image/png;base64,{img_base64}"

    def visualize_plotly(self) -> go.Figure:
        """
        使用Plotly生成交互式图

        Returns:
            Plotly Figure对象
        """
        # 计算布局
        try:
            pos = nx.spring_layout(self.graph, k=2, iterations=50)
        except:
            pos = nx.random_layout(self.graph)

        # 创建边的trace
        edge_traces = []

        for edge in self.graph.edges():
            x0, y0 = pos[edge[0]]
            x1, y1 = pos[edge[1]]

            edge_trace = go.Scatter(
                x=[x0, x1, None],
                y=[y0, y1, None],
                mode='lines',
                line=dict(width=1, color='#888'),
                hoverinfo='none',
                showlegend=False
            )
            edge_traces.append(edge_trace)

        # 创建节点的trace
        node_x = []
        node_y = []
        node_text = []
        node_color = []
        node_size = []

        importance_color_map = {
            "high": "#e74c3c",
            "medium": "#f39c12",
            "low": "#95a5a6"
        }

        for node in self.graph.nodes():
            x, y = pos[node]
            node_x.append(x)
            node_y.append(y)

            node_data = self.graph.nodes[node]
            title = node_data.get("title", node)
            kp_type = node_data.get("type", "unknown")
            importance = node_data.get("importance", "medium")
            difficulty = node_data.get("difficulty", "intermediate")

            node_text.append(f"{title}<br>类型: {kp_type}<br>重要性: {importance}<br>难度: {difficulty}")
            node_color.append(importance_color_map.get(importance, "#3498db"))
            node_size.append(30 if importance == "high" else 20)

        node_trace = go.Scatter(
            x=node_x,
            y=node_y,
            mode='markers+text',
            text=[self.graph.nodes[node].get("title", node)[:8] for node in self.graph.nodes()],
            textposition="top center",
            hovertext=node_text,
            hoverinfo='text',
            marker=dict(
                size=node_size,
                color=node_color,
                line=dict(width=2, color='white')
            ),
            showlegend=False
        )

        # 创建图形
        fig = go.Figure(
            data=edge_traces + [node_trace],
            layout=go.Layout(
                title="知识点依赖图（可交互）",
                titlefont_size=16,
                showlegend=False,
                hovermode='closest',
                margin=dict(b=20, l=5, r=5, t=40),
                xaxis=dict(showgrid=False, zeroline=False, showticklabels=False),
                yaxis=dict(showgrid=False, zeroline=False, showticklabels=False),
                plot_bgcolor='white'
            )
        )

        return fig

    def get_learning_path(self, start_node: Optional[str] = None) -> List[str]:
        """
        获取推荐的学习路径（拓扑排序）

        Args:
            start_node: 起始节点，None时自动选择

        Returns:
            节点ID列表
        """
        try:
            # 拓扑排序
            path = list(nx.topological_sort(self.graph))
            return path
        except nx.NetworkXError:
            # 如果有环，返回简单的BFS路径
            if start_node and start_node in self.graph.nodes:
                return list(nx.bfs_tree(self.graph, start_node).nodes())
            else:
                # 选择入度为0的节点作为起点
                in_degrees = dict(self.graph.in_degree())
                start_nodes = [n for n, d in in_degrees.items() if d == 0]

                if start_nodes:
                    return list(nx.bfs_tree(self.graph, start_nodes[0]).nodes())
                else:
                    return list(self.graph.nodes())

    def get_prerequisites(self, node_id: str) -> List[str]:
        """
        获取指定节点的所有前置知识

        Args:
            node_id: 节点ID

        Returns:
            前置知识节点ID列表
        """
        if node_id not in self.graph.nodes:
            return []

        return list(self.graph.predecessors(node_id))

    def get_dependents(self, node_id: str) -> List[str]:
        """
        获取依赖指定节点的所有知识点

        Args:
            node_id: 节点ID

        Returns:
            依赖节点ID列表
        """
        if node_id not in self.graph.nodes:
            return []

        return list(self.graph.successors(node_id))

    def analyze_graph(self) -> Dict[str, Any]:
        """
        分析图的特征

        Returns:
            分析结果
        """
        analysis = {
            "node_count": self.graph.number_of_nodes(),
            "edge_count": self.graph.number_of_edges(),
            "is_dag": nx.is_directed_acyclic_graph(self.graph),
            "average_degree": sum(dict(self.graph.degree()).values()) / max(self.graph.number_of_nodes(), 1)
        }

        # 识别关键节点
        if self.graph.number_of_nodes() > 0:
            in_degrees = dict(self.graph.in_degree())
            out_degrees = dict(self.graph.out_degree())

            # 入度最高（最多前置知识）
            analysis["most_prerequisites"] = max(in_degrees, key=in_degrees.get) if in_degrees else None

            # 出度最高（最多依赖）
            analysis["most_dependents"] = max(out_degrees, key=out_degrees.get) if out_degrees else None

            # 入度为0的节点（基础知识点）
            analysis["foundation_nodes"] = [n for n, d in in_degrees.items() if d == 0]

            # 出度为0的节点（高级知识点）
            analysis["advanced_nodes"] = [n for n, d in out_degrees.items() if d == 0]

        return analysis
